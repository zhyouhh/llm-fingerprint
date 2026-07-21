#!/usr/bin/env node
// Pairwise-compare fingerprints collected from the SAME endpoint.
//
// Why this is stronger than ranking against the reference database: every model name
// here went through the same gateway, the same injected harness, the same temperature
// handling and the same reasoning behaviour. Those confounds cancel, so a small
// distance really does mean "same backend" rather than "same measurement conditions".
//
// Usage: node scripts/compare-baselines.js baselines/probe-a.json baselines/probe-b.json ...
import { readFileSync } from 'node:fs';
import { jsd } from '../src/stats/jsd.js';

// Calibration from the published study (results/divergence.json, split-scores.json):
// same model measured twice vs. two genuinely different models.
const GENUINE_MEDIAN = 0.075;
const IMPOSTOR_MEDIAN = 0.489;

const files = process.argv.slice(2);
if (files.length < 2) { console.error('need >=2 baseline files'); process.exit(1); }

const fps = files.map((f) => {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return { model: j.model, endpoint: j.endpoint, fp: j.fingerprint, reasoning: j.reasoning_rate, cells: j.cells };
});

const endpoints = new Set(fps.map((f) => f.endpoint));
if (endpoints.size > 1) {
  console.log('⚠️  baselines span multiple endpoints — harness confounds do NOT cancel.\n');
}

console.log('fingerprints:');
for (const f of fps) console.log(`  ${f.model.padEnd(16)} cells=${f.cells.length}  reasoning_rate=${(f.reasoning * 100).toFixed(1)}%`);

console.log('\npairwise mean JSD (same endpoint → confounds cancel):\n');
const rows = [];
for (let i = 0; i < fps.length; i++) {
  for (let j = i + 1; j < fps.length; j++) {
    const a = fps[i], b = fps[j];
    const shared = Object.keys(a.fp).filter((c) => b.fp[c]);
    const mean = shared.reduce((s, c) => s + jsd(a.fp[c], b.fp[c]), 0) / shared.length;
    rows.push({ a: a.model, b: b.model, jsd: +mean.toFixed(4), cells: shared.length });
  }
}
rows.sort((x, y) => x.jsd - y.jsd);
for (const r of rows) {
  const verdict = r.jsd < 0.12 ? '← 同一后端的量级'
    : r.jsd > 0.30 ? '← 明显不同模型'
      : '← 中间地带，说不清';
  console.log(`  ${r.a.padEnd(14)} vs ${r.b.padEnd(14)} JSD=${r.jsd.toFixed(4)} (${r.cells} cells)  ${verdict}`);
}

console.log(`\ncalibration: same-model median ${GENUINE_MEDIAN}, different-model median ${IMPOSTOR_MEDIAN}`);
console.log('(from the published study; our absolute values sit higher when the endpoint');
console.log(' contaminates samples, so read the SPREAD between pairs, not the raw numbers.)');

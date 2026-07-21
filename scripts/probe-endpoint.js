#!/usr/bin/env node
// Probe one endpoint and rank it against the published 176-model reference database.
//
// Usage:
//   node scripts/probe-endpoint.js --endpoint URL --key KEY --model NAME [--reps 30] [--full]
//
// The verdict is a RANKING, not a proof. Read docs in CLAUDE.md before trusting it:
// the reference database was collected on bare APIs at temperature 1 with a clean
// ~40-token prompt. An endpoint that injects a harness prompt or ignores temperature
// violates those conditions, and a mismatch then says nothing about the model.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAIAdapter } from '../src/probe/adapters/openai.js';
import { runBattery, QUICK_CELLS, fullCells } from '../src/probe/runner.js';
import { loadVendorConfig } from '../src/normalize/index.js';
import { createNormalizer } from '../vendor/pamela/normalize-core.js';
import { buildDistributions } from '../src/stats/distributions.js';
import { jsd, MIN_N } from '../src/stats/jsd.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const endpoint = args.endpoint ?? process.env.LLMFP_ENDPOINT;
const apiKey = args.key ?? process.env.LLMFP_API_KEY;
const model = args.model;
const reps = Number(args.reps ?? 30);
if (!endpoint || !apiKey || !model) {
  console.error('need --endpoint --key --model (endpoint/key fall back to env)');
  process.exit(1);
}

const { prompts, colorLex } = loadVendorConfig();
const cells = args.full ? fullCells(prompts) : QUICK_CELLS;

console.log(`probing ${model} @ ${endpoint.replace(/\/\/[^/]*@/, '//')}`);
console.log(`  ${cells.length} cells x ${reps} reps = ${cells.length * reps} requests\n`);

const ask = createOpenAIAdapter({ endpoint, apiKey });
const { records, failures, reasoningRate } = await runBattery({
  ask, model, cells, reps,
  onProgress: ({ done, total, ok, failed }) =>
    process.stdout.write(`\r  ${done}/${total}  ok=${ok} failed=${failed}   `),
});
console.log(`\n  collected ${records.length}, failed ${failures.length}`);

// ---- reasoning gate (upstream's exclusion rule, applied live) ----
console.log(`\n  reasoning-trace rate: ${(reasoningRate * 100).toFixed(1)}%`);
if (reasoningRate >= 0.3) {
  console.log('  ⚠️  >=30% of samples carry a hidden reasoning trace. Upstream excludes such');
  console.log('      model/provider pairs entirely: these are not single-pass samples, so the');
  console.log('      fingerprint below is NOT comparable with the reference database.');
}

// ---- normalise + distributions ----
const normalize = createNormalizer(prompts, colorLex);
const normalized = records.map((r) => ({ ...r, ...normalize(r) }));
const validRate = normalized.filter((r) => r.answer_class === 'valid').length / (normalized.length || 1);
console.log(`  valid answer rate: ${(validRate * 100).toFixed(1)}%`);
if (validRate < 0.2) {
  console.log('  ✗ below 20% — endpoint cannot produce single-pass completions. Aborting.');
  process.exit(2);
}

const ours = buildDistributions(normalized, { temperature: 1 });
const ourFp = {};
for (const c of ours) if (c.n_valid >= MIN_N) ourFp[`${c.task_id}|${c.lang}`] = c.dist;
const sampledCells = Object.keys(ourFp);
console.log(`  usable cells: ${sampledCells.length}/${cells.length}`);

// ---- compare against the reference database ----
const refPath = path.join(ROOT, 'data', 'upstream', 'data', 'results', 'distributions.json');
const ref = JSON.parse(readFileSync(refPath, 'utf8')).distributions;
const byModel = new Map();
for (const c of ref) {
  if (c.n_valid < MIN_N) continue;
  const cell = `${c.task_id}|${c.lang}`;
  if (!sampledCells.includes(cell)) continue;
  if (!byModel.has(c.model)) byModel.set(c.model, {});
  byModel.get(c.model)[cell] = c.dist;
}

const ranked = [];
for (const [m, fp] of byModel) {
  const shared = sampledCells.filter((c) => fp[c]);
  if (shared.length < sampledCells.length * 0.75) continue; // need most cells to compare
  const mean = shared.reduce((s, c) => s + jsd(ourFp[c], fp[c]), 0) / shared.length;
  ranked.push({ model: m, jsd: +mean.toFixed(4), cells: shared.length });
}
ranked.sort((a, b) => a.jsd - b.jsd);

const claimedIdx = ranked.findIndex((r) => r.model.split('/').pop().replace(/-/g, '.') === model.replace(/-/g, '.'));
console.log(`\n  compared against ${ranked.length} reference models\n`);
console.log('  rank  JSD     model');
ranked.slice(0, 10).forEach((r, i) => {
  const mark = i === claimedIdx ? ' <-- claimed' : '';
  console.log(`  ${String(i + 1).padStart(4)}  ${r.jsd.toFixed(4)}  ${r.model}${mark}`);
});
if (claimedIdx > 9) {
  console.log(`  ...`);
  console.log(`  ${String(claimedIdx + 1).padStart(4)}  ${ranked[claimedIdx].jsd.toFixed(4)}  ${ranked[claimedIdx].model} <-- claimed`);
}
if (claimedIdx === -1) console.log(`  (claimed model "${model}" has no entry in the reference database)`);

const outDir = path.join(ROOT, 'baselines');
mkdirSync(outDir, { recursive: true });
const stamp = model.replace(/[^\w.-]/g, '_');
const outPath = path.join(outDir, `probe-${stamp}.json`);
// Per-sample rows are kept so downstream analysis can STRATIFY. A gateway that
// rotates across several upstream accounts emits a mixture, not one distribution;
// prompt_tokens differs per account harness and therefore labels the stratum.
// Comparing a mixture against a single-account fingerprint is invalid, so the raw
// rows must survive the aggregation step.
const samples = normalized.map((r) => ({
  cell: `${r.task_id}|${r.lang}`, rep: r.rep,
  normalized: r.normalized, answer_class: r.answer_class,
  prompt_tokens: r.usage?.prompt_tokens ?? null,
  reasoning_len: r.reasoning_len ?? null,
}));

writeFileSync(outPath, JSON.stringify({
  endpoint, model, cells: sampledCells, reps,
  reasoning_rate: reasoningRate, valid_rate: validRate,
  fingerprint: ourFp, ranking: ranked.slice(0, 25), failures: failures.length,
  samples,
}, null, 2));

const strata = {};
for (const s of samples) strata[s.prompt_tokens] = (strata[s.prompt_tokens] ?? 0) + 1;
const strataKeys = Object.keys(strata);
console.log(`  prompt_tokens strata: ${JSON.stringify(strata)}`);
if (strataKeys.length > 1) {
  console.log('  ⚠️  multiple strata → this endpoint rotates upstream accounts for this model.');
  console.log('      Analyse per stratum; the pooled fingerprint is a mixture.');
}
console.log(`\n  saved ${path.relative(ROOT, outPath)}`);

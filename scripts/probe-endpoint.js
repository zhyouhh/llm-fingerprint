#!/usr/bin/env node
// Probe one endpoint and rank it against the published 176-model reference database.
//
// Usage:
//   node scripts/probe-endpoint.js --endpoint <id> --model NAME [--reps 30] [--full]
//
// Operations tool, not part of the main flow: this is how a new genuine reference gets
// collected (决策 #9), and how a model that IS in the paper's database gets ranked.
//
// The verdict is a RANKING, not a proof. The reference database was collected on bare
// APIs at temperature 1 with a clean ~40-token prompt; an endpoint that injects a
// harness prompt or ignores temperature violates those conditions, and a mismatch then
// says nothing about the model. Read CLAUDE.md before trusting it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg } from '../src/lib/cli.js';
import { createChatProbe } from '../src/probe/http/chat.js';
import { runBattery, QUICK_CELLS, fullCells } from '../src/probe/runner.js';
import { loadVendorConfig } from '../src/normalize/index.js';
import { buildDistributions } from '../src/stats/distributions.js';
import { jsd, MIN_N } from '../src/stats/jsd.js';
import { rates } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/probe-endpoint.js --endpoint <id> [--model NAME] [--reps 30] [--full]

  --endpoint <id>  端点 id，见 config/endpoints.json
  --model NAME     待测模型（默认取该端点的 models.subject）
  --reps N         每格采样次数（默认 30）
  --full           跑完整 40 格电池，而不是默认的 8 格快筛电池`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });

const model = args.model ?? endpoint.models.subject;
const reps = Number(args.reps ?? 30);
if (!model) {
  console.error('need --model (or a models.subject in config/endpoints.json)');
  process.exit(2);
}

const { prompts } = loadVendorConfig();
const cells = args.full ? fullCells(prompts) : QUICK_CELLS;

console.log(`probing ${model} @ ${endpoint.id} (${endpoint.base_url})`);
console.log(`  ${cells.length} cells x ${reps} reps = ${cells.length * reps} logical probes\n`);

const probe = createChatProbe({ baseUrl: endpoint.base_url, apiKey });
const { samples, counters, reasoningRate } = await runBattery({
  // true: this script ranks against the paper's 176-model database, which WAS built
  // with the trace pass. (A reference collected here for L1/L2 use is a different
  // job — see the note in src/normalize/index.js.)
  probe, model, cells, reps, applyReasoningTrace: true,
  onProgress: ({ done, total }) => process.stdout.write(`\r  ${done}/${total}   `),
});

const failed = samples.filter((s) => s.state === 'transport_failure').length;
console.log(`\n  ${counters.probes} logical probes, ${counters.http_attempts} network attempts, ${failed} failed`);

// ---- reasoning gate (upstream's exclusion rule, applied live) ----
console.log(`\n  reasoning-trace rate: ${(reasoningRate * 100).toFixed(1)}%`);
if (reasoningRate >= 0.3) {
  console.log('  ⚠️  >=30% of samples carry a hidden reasoning trace. Upstream excludes such');
  console.log('      model/provider pairs entirely: these are not single-pass samples, so the');
  console.log('      fingerprint below is NOT comparable with the reference database.');
}

// ---- gate on the valid rate (硬约束: the method does not apply below 20%) ----
const r = rates(samples, { logicalSamples: counters.probes });
console.log(`  valid answer rate: ${(r.valid_rate * 100).toFixed(1)}%  (response rate ${(r.response_rate * 100).toFixed(1)}%)`);
if (r.valid_rate < 0.2) {
  console.log('  ✗ below 20% — endpoint cannot produce single-pass completions. Aborting.');
  process.exit(2);
}

// ---- distributions ----
// runBattery already normalised the batch (the post_reasoning pre-pass is per-batch and
// cannot be done sample by sample), so the samples carry answer_class already.
const ours = buildDistributions(samples, { temperature: 1 });
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

const claimedIdx = ranked.findIndex((x) => x.model.split('/').pop().replace(/-/g, '.') === model.replace(/-/g, '.'));
console.log(`\n  compared against ${ranked.length} reference models\n`);
console.log('  rank  JSD     model');
ranked.slice(0, 10).forEach((x, i) => {
  const mark = i === claimedIdx ? ' <-- claimed' : '';
  console.log(`  ${String(i + 1).padStart(4)}  ${x.jsd.toFixed(4)}  ${x.model}${mark}`);
});
if (claimedIdx > 9) {
  console.log('  ...');
  console.log(`  ${String(claimedIdx + 1).padStart(4)}  ${ranked[claimedIdx].jsd.toFixed(4)}  ${ranked[claimedIdx].model} <-- claimed`);
}
if (claimedIdx === -1) console.log(`  (claimed model "${model}" has no entry in the reference database)`);

// ---- persist ----
// Per-sample rows are kept so downstream analysis can STRATIFY. A gateway that rotates
// across several upstream accounts emits a mixture, not one distribution; prompt_tokens
// differs per account harness and therefore labels the stratum. Comparing a mixture
// against a single-account fingerprint is invalid, so the raw rows must survive.
const outDir = path.join(ROOT, 'baselines');
mkdirSync(outDir, { recursive: true });
// 🔴 Named per endpoint AND model: a fixed filename silently overwrote a previously
// collected baseline once already.
const stamp = `${endpoint.id}-${model}`.replace(/[^\w.-]/g, '_');
const outPath = path.join(outDir, `probe-${stamp}.json`);

const rows = samples.map((s) => ({
  cell: `${s.task_id}|${s.lang}`, rep: s.rep, state: s.state,
  normalized: s.normalized, answer_class: s.answer_class,
  prompt_tokens: s.usage?.prompt_tokens ?? null,
  reasoning_len: s.reasoning_len ?? null,
  attempts: s.attempts,
}));

writeFileSync(outPath, JSON.stringify({
  endpoint: endpoint.base_url, endpoint_id: endpoint.id, model,
  cells: sampledCells, reps,
  probes: counters.probes, http_attempts: counters.http_attempts,
  reasoning_rate: reasoningRate, valid_rate: r.valid_rate, response_rate: r.response_rate,
  fingerprint: ourFp, ranking: ranked.slice(0, 25), failures: failed,
  samples: rows,
}, null, 2));

const strata = {};
for (const s of rows) strata[s.prompt_tokens] = (strata[s.prompt_tokens] ?? 0) + 1;
console.log(`  prompt_tokens strata: ${JSON.stringify(strata)}`);
if (Object.keys(strata).length > 1) {
  console.log('  ⚠️  multiple strata → this endpoint rotates upstream accounts for this model.');
  console.log('      Analyse per stratum; the pooled fingerprint is a mixture.');
}
console.log(`\n  saved ${path.relative(ROOT, outPath)}`);

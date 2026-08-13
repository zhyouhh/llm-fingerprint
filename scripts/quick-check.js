#!/usr/bin/env node
// Layer 1: is this endpoint quietly serving a cheaper reasoning setting?
//
// You ask for high effort. A relay that silently downgrades still answers, just worse.
// The fingerprint layer cannot see this — it compares answer distributions on trivial
// one-word prompts, which look identical at any effort. So this layer asks hard
// questions whose answers we compute ourselves, and compares the endpoint's accuracy
// against calibrated reference rates for the same model at high and at low.
//
// The comparison is statistical, not per-item. At the calibrated difficulty the genuine
// model is right about 67% of the time at high effort and 33% at low, so a single wrong
// answer means nothing and a run needs enough probes to tell those rates apart. The
// calibration file reports how many; --n defaults to that.
//
// Usage:
//   node scripts/quick-check.js --endpoint <id> [--model gpt-5.6-sol]
//                               [--effort high] [--n 36]
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, parseInteger } from '../src/probes/reasoning.js';
import { parseArgs, resolveEndpointArg } from '../src/lib/cli.js';
import { createResponsesClient } from '../src/probe/http/responses.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/quick-check.js --endpoint <id> [--model M] [--effort high] [--n 36]

  --endpoint <id>  端点 id，见 config/endpoints.json
  --model M        待测模型（默认取该端点的 models.subject）
  --effort LEVEL   请求的 reasoning 档位（默认 high）
  --n N            题数（默认按 probes/calibration.json 算出的所需样本量）`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
const model = args.model ?? endpoint.models.subject ?? 'gpt-5.6-sol';
const effort = args.effort ?? 'high';

const calPath = path.join(ROOT, 'probes', 'calibration.json');
if (!existsSync(calPath)) {
  console.error('missing probes/calibration.json — calibrate on a known-genuine endpoint first:');
  console.error('  node scripts/calibrate-probes.js --endpoint <genuine-id>');
  process.exit(1);
}
const cal = JSON.parse(readFileSync(calPath, 'utf8'));

// Only families that demonstrably separate the effort levels carry information here.
const FAMILY = 'adaptive-pair';
const fam = cal.by_family?.[FAMILY];
if (!fam) { console.error(`calibration has no ${FAMILY} data`); process.exit(1); }
const pHigh = fam.accHigh / fam.reps;
const pLow = fam.accLow / fam.reps;
const pbar = (pHigh + pLow) / 2;
const nDefault = Math.ceil((1.96 + 0.84) ** 2 * 2 * pbar * (1 - pbar) / (pHigh - pLow) ** 2);
const n = Number(args.n ?? nDefault);

// Seed from the clock so every run is a fresh set of instances. A relay that logged a
// previous run's questions gains nothing.
const seed0 = (Date.now() % 1e6) | 0;
const probes = generate(n * 2, seed0).filter((p) => p.family === FAMILY).slice(0, n);

console.log(`reasoning check: ${model} @ ${endpoint.id} (${endpoint.base_url})  effort=${effort}`);
console.log(`  reference rates for this model — high ${(pHigh * 100).toFixed(0)}%, low ${(pLow * 100).toFixed(0)}%`);
console.log(`  ${probes.length} freshly generated ${FAMILY} probes\n`);

// Shared outbound client (I-4): retry lives inside it, and it never throws for a
// transport-level outcome — a null return here means "no usable answer", nothing more.
const client = createResponsesClient({ baseUrl: endpoint.base_url, apiKey });

async function ask(prompt) {
  const r = await client({ model, input: prompt, maxOutputTokens: 8192, reasoning: { effort } });
  if (r.error) return null;
  return { val: parseInteger(r.raw), out: r.usage?.output_tokens ?? null };
}

let correct = 0, answered = 0;
const tokens = [];
for (const [i, p] of probes.entries()) {
  const r = await ask(p.prompt);
  if (r) { answered++; if (r.val === p.answer) correct++; if (r.out != null) tokens.push(r.out); }
  process.stdout.write(`\r  ${i + 1}/${probes.length}  correct ${correct}/${answered}   `);
}
console.log();

if (answered < probes.length * 0.6) {
  console.log(`\n✗ only ${answered}/${probes.length} answered — endpoint too unreliable to judge.`);
  process.exit(2);
}

const rate = correct / answered;
const med = tokens.length ? tokens.slice().sort((a, b) => a - b)[tokens.length >> 1] : null;
console.log(`\n  accuracy ${correct}/${answered} = ${(rate * 100).toFixed(0)}%`);
if (med) console.log(`  median output_tokens ${med}`);

// Which reference rate is the observation closer to?
const dHigh = Math.abs(rate - pHigh), dLow = Math.abs(rate - pLow);
console.log('\nverdict:');
if (rate >= pHigh - 0.1) {
  console.log(`  ✅ consistent with ${effort} effort on the genuine model`);
} else if (dLow < dHigh) {
  console.log(`  ✗ accuracy sits nearer the LOW-effort reference (${(pLow * 100).toFixed(0)}%) than the high one`);
  console.log(`     → the endpoint may be downgrading effort behind your back`);
} else {
  console.log('  ⚠️  between the two reference rates — inconclusive; re-run with a larger --n');
}
console.log('\n  note: rates come from a 12-sample calibration, so they are themselves rough.');
console.log('  Re-calibrate against a known-genuine endpoint when the model version changes.');

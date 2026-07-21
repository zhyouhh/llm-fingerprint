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
//   node scripts/quick-check.js --endpoint URL --key KEY [--model gpt-5.6-sol]
//                               [--effort high] [--n 36]
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, parseInteger } from '../src/probes/reasoning.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const endpoint = args.endpoint ?? process.env.LLMFP_ENDPOINT;
const apiKey = args.key ?? process.env.LLMFP_API_KEY;
const model = args.model ?? 'gpt-5.6-sol';
const effort = args.effort ?? 'high';
if (!endpoint || !apiKey) { console.error('need --endpoint and --key'); process.exit(1); }

const calPath = path.join(ROOT, 'probes', 'calibration.json');
if (!existsSync(calPath)) {
  console.error('missing probes/calibration.json — calibrate on a known-genuine endpoint first:');
  console.error('  node scripts/calibrate-probes.js --endpoint <genuine> --key <k>');
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

console.log(`layer 1: ${model} @ ${endpoint}  (effort=${effort})`);
console.log(`  reference rates for this model — high ${(pHigh * 100).toFixed(0)}%, low ${(pLow * 100).toFixed(0)}%`);
console.log(`  ${probes.length} freshly generated ${FAMILY} probes\n`);

async function ask(prompt) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${endpoint.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: prompt, max_output_tokens: 8192, reasoning: { effort } }),
      });
      if (!r.ok) { await new Promise((s) => setTimeout(s, 2000 * (a + 1))); continue; }
      const j = await r.json();
      let text = '';
      for (const item of j.output ?? []) for (const c of item.content ?? []) if (c.text) text += c.text;
      return { val: parseInteger(text), out: j.usage?.output_tokens ?? null };
    } catch { await new Promise((s) => setTimeout(s, 2000 * (a + 1))); }
  }
  return null;
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

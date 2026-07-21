#!/usr/bin/env node
// Calibrate generated reasoning probes on a KNOWN-GENUINE endpoint.
//
// A probe only carries information if it can fail. We learned this the hard way: the
// first probe used here ("minimum draws to guarantee 3 of a colour") was answered
// correctly at every effort level, and its passing was misread as proof that the
// endpoint ignored the effort parameter. It proved nothing — the task was simply too
// easy to degrade.
//
// So before a probe is allowed into layer 1, it must clear a bar on an endpoint already
// known to serve the genuine model: correct at high effort, and demonstrably worse at
// low. Probes that pass at both levels are discarded as blunt; probes that fail at both
// are discarded as broken or beyond the model.
//
// Usage:
//   node scripts/calibrate-probes.js --endpoint URL --key KEY [--model gpt-5.6-sol]
//                                    [--n 8] [--reps 3] [--out probes/calibration.json]
import { writeFileSync, mkdirSync } from 'node:fs';
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
const n = Number(args.n ?? 8);
const reps = Number(args.reps ?? 3);
const outPath = args.out ?? path.join(ROOT, 'probes', 'calibration.json');
if (!endpoint || !apiKey) { console.error('need --endpoint and --key'); process.exit(1); }

/** Codex-lineage relays speak the Responses API; effort lives in reasoning.effort. */
async function ask(prompt, effort) {
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
      return { text: text.trim(), out: j.usage?.output_tokens ?? null };
    } catch { await new Promise((s) => setTimeout(s, 2000 * (a + 1))); }
  }
  return null;
}

const probes = generate(n, Number(args.seed ?? 1));
console.log(`calibrating ${probes.length} probes on ${model} @ ${endpoint}`);
console.log(`  ${reps} reps x 2 effort levels each = ${probes.length * reps * 2} requests\n`);

const results = [];
for (const p of probes) {
  const row = { family: p.family, seed: p.seed, answer: p.answer, low: [], high: [], tokens: { low: [], high: [] } };
  for (const effort of ['low', 'high']) {
    for (let i = 0; i < reps; i++) {
      const r = await ask(p.prompt, effort);
      row[effort].push(r ? parseInteger(r.text) : null);
      if (r?.out != null) row.tokens[effort].push(r.out);
    }
  }
  const acc = (xs) => xs.filter((v) => v === p.answer).length;
  row.accLow = acc(row.low);
  row.accHigh = acc(row.high);
  row.usable = row.accHigh === reps && row.accLow < reps;
  const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[xs.length >> 1] : null);
  row.tokenRatio = med(row.tokens.high) && med(row.tokens.low)
    ? +(med(row.tokens.high) / med(row.tokens.low)).toFixed(2) : null;
  results.push(row);
  console.log(`  [${row.family.padEnd(14)}] seed=${String(row.seed).padEnd(4)} ans=${String(row.answer).padEnd(3)} ` +
    `high ${row.accHigh}/${reps}  low ${row.accLow}/${reps}  tok(high/low)=${row.tokenRatio ?? '-'}  ${row.usable ? '✅ 可用' : '— 弃用'}`);
}

const byFamily = {};
for (const r of results) {
  const f = (byFamily[r.family] ??= { n: 0, usable: 0, accHigh: 0, accLow: 0, reps: 0 });
  f.n++; f.usable += r.usable ? 1 : 0; f.accHigh += r.accHigh; f.accLow += r.accLow; f.reps += reps;
}
console.log('\nby family:');
for (const [f, s] of Object.entries(byFamily)) {
  console.log(`  ${f.padEnd(15)} usable ${s.usable}/${s.n}   high ${s.accHigh}/${s.reps}   low ${s.accLow}/${s.reps}`);
}

// Judge at FAMILY level on aggregate accuracy, not per instance. With a handful of
// reps a single sample flips an instance between "3/3" and "2/3", so per-instance
// pass/fail is mostly noise. What matters is whether the family's accuracy separates
// the two effort levels — that is the signal layer 1 actually consumes.
console.log('\ndiscrimination (aggregate, the statistic layer 1 uses):');
const usableFamilies = [];
for (const [f, s] of Object.entries(byFamily)) {
  const hi = s.accHigh / s.reps, lo = s.accLow / s.reps;
  const gap = hi - lo;
  const ok = gap >= 0.2 && hi >= 0.5;
  if (ok) usableFamilies.push(f);
  console.log(`  ${f.padEnd(15)} high ${(hi * 100).toFixed(0)}%  low ${(lo * 100).toFixed(0)}%  gap ${(gap * 100).toFixed(0)}pt  ${ok ? '✅ 有区分度' : '— 无区分度'}`);
}
if (!usableFamilies.length) console.log('  (none — widen the difficulty range or add reps)');

// Sample size needed to tell the two rates apart, two-proportion z-test at ~95%/80%.
for (const f of usableFamilies) {
  const s = byFamily[f];
  const p1 = s.accHigh / s.reps, p2 = s.accLow / s.reps, pbar = (p1 + p2) / 2;
  const nNeeded = Math.ceil((1.96 + 0.84) ** 2 * 2 * pbar * (1 - pbar) / (p1 - p2) ** 2);
  console.log(`  → ${f}: ~${nNeeded} probes per run to separate these rates (95%/80%)`);
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  calibrated_on: { endpoint_label: 'genuine reference', model }, reps,
  note: 'Instances are regenerated per run; only the FAMILY-level discrimination is reused.',
  by_family: byFamily, usable_families: usableFamilies, results,
}, null, 1));
console.log(`\nsaved ${path.relative(ROOT, outPath)}`);

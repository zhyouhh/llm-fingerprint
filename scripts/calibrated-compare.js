#!/usr/bin/env node
// Cross-endpoint model verification, calibrated against a known-same-model control.
//
// The problem this solves: two gateways wrap requests in different harnesses, so the
// same model measured through both yields different distributions. A raw cross-endpoint
// JSD therefore mixes "different harness" with "different model" and proves nothing.
//
// The fix: measure the harness term directly. Pick a control model that BOTH endpoints
// serve and that is independently known to be genuine on both. Its cross-endpoint JSD
// is pure harness effect (call it H), because the model is the same by assumption.
// Then judge the subject model's cross-endpoint JSD (S) against H rather than against
// the paper's same-model median.
//
//   S ≈ H   → the subject behaves like the same model once the harness is accounted for
//   S ≫ H   → the gap exceeds what the harness can explain
//
// Stratification: a gateway rotating across upstream accounts emits a MIXTURE. Its
// prompt_tokens differ per account harness, so that field labels the stratum. Comparing
// a mixture against a single-account fingerprint is invalid; pass --stratum to pin one.
//
// Usage:
//   node scripts/calibrated-compare.js \
//     --control-a baselines/own-gpt-5.4.json     --control-b baselines/probe-gpt-5.4.json \
//     --subject-a baselines/own-gpt-5.6-sol.json --subject-b baselines/probe-gpt-5.6-sol.json
import { readFileSync } from 'node:fs';
import { jsd } from '../src/stats/jsd.js';

const MIN_N = 10;
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return a;
}, []));

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Distinct prompt_tokens values and their counts — one stratum per upstream harness. */
function strata(run) {
  const s = {};
  for (const r of run.samples ?? []) s[r.prompt_tokens] = (s[r.prompt_tokens] ?? 0) + 1;
  return s;
}

/**
 * Rebuild a fingerprint from raw samples, optionally restricted to one stratum.
 * @param {object} run   a baselines/*.json produced by probe-endpoint.js
 * @param {number|null} stratum  prompt_tokens value to keep, or null for all
 */
function fingerprint(run, stratum = null) {
  if (!run.samples) return { fp: run.fingerprint, n: null };
  const counts = {};
  for (const r of run.samples) {
    if (r.answer_class !== 'valid') continue;
    if (stratum !== null && r.prompt_tokens !== stratum) continue;
    (counts[r.cell] ??= {})[r.normalized] = ((counts[r.cell] ?? {})[r.normalized] ?? 0) + 1;
  }
  const fp = {};
  let kept = 0;
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    if (n < MIN_N) continue;
    kept += n;
    fp[cell] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, +(v / n).toFixed(4)]));
  }
  return { fp, n: kept };
}

function meanJsd(a, b) {
  const shared = Object.keys(a).filter((c) => b[c]);
  if (!shared.length) return { jsd: NaN, cells: 0 };
  return { jsd: +(shared.reduce((s, c) => s + jsd(a[c], b[c]), 0) / shared.length).toFixed(4), cells: shared.length };
}

const runs = {
  controlA: load(args['control-a']), controlB: load(args['control-b']),
  subjectA: load(args['subject-a']), subjectB: load(args['subject-b']),
};

console.log('strata (prompt_tokens -> sample count):');
for (const [k, r] of Object.entries(runs)) console.log(`  ${k.padEnd(9)} ${r.model.padEnd(14)} ${JSON.stringify(strata(r))}`);

// Endpoint A is the reference gateway; pin it to the subject's harness when it rotates.
const subjStrata = Object.keys(strata(runs.subjectA)).map(Number);
const pin = args.stratum ? Number(args.stratum) : (subjStrata.length === 1 ? subjStrata[0] : null);
if (pin !== null) console.log(`\npinning endpoint-A strata to prompt_tokens=${pin} (the subject's harness)`);
else console.log('\n⚠️  subject on endpoint A spans multiple strata — cannot pin; result is a mixture comparison');

const cA = fingerprint(runs.controlA, pin), cB = fingerprint(runs.controlB);
const sA = fingerprint(runs.subjectA, pin), sB = fingerprint(runs.subjectB);
for (const [n, f] of [['controlA', cA], ['controlB', cB], ['subjectA', sA], ['subjectB', sB]]) {
  if (!Object.keys(f.fp).length) { console.error(`\n✗ ${n}: no usable cells after stratification`); process.exit(2); }
}

const H = meanJsd(cA.fp, cB.fp);
const S = meanJsd(sA.fp, sB.fp);

console.log(`\n  H (harness term, control model ${runs.controlA.model}, known same on both) = ${H.jsd}  [${H.cells} cells]`);
console.log(`  S (subject      ${runs.subjectA.model}, cross-endpoint)                     = ${S.jsd}  [${S.cells} cells]`);
console.log(`  S / H = ${(S.jsd / H.jsd).toFixed(2)}`);

// Within-endpoint control: how far apart are two genuinely DIFFERENT models on the
// same endpoint? That sets the scale for "a real model difference" under this harness.
const D = meanJsd(fingerprint(runs.subjectB).fp, fingerprint(runs.controlB).fp);
console.log(`  D (different-model scale, ${runs.subjectB.model} vs ${runs.controlB.model} on endpoint B) = ${D.jsd}`);

console.log('\nverdict:');
if (!Number.isFinite(S.jsd) || !Number.isFinite(H.jsd)) console.log('  inconclusive — missing overlap');
else if (S.jsd <= H.jsd * 1.5) console.log(`  ✅ S is within 1.5x of the harness term → consistent with the SAME model`);
else if (S.jsd >= D.jsd * 0.7) console.log(`  ✗ S approaches the different-model scale → substitution likely`);
else console.log(`  ⚠️  S sits between the harness term and the different-model scale → inconclusive; add cells or reps`);

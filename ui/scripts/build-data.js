#!/usr/bin/env node
// Build the browser's copy of reference/ — and prove it is the same measurement.
//
//   node ui/scripts/build-data.js [--out <dir>]
//
// A reference file is ~220KB, of which 95% is `samples`: 1200 full records the browser
// would download and immediately throw away. What the statistics actually need out of
// them is one thing — each cell's valid answers, IN ORDER — so that is what ships.
//
// 🔴 Order is not cosmetic. noiseFloor draws WITH REPLACEMENT by index
// (drawWithReplacement(pool, reps, rng)), so a reordered pool produces a different floor,
// and the floor is a denominator in the L2 verdict. Sorting, deduping or count-compressing
// the answers would all "work" and all quietly move the numbers.
//
// So this script does not merely convert: it re-runs the judgement path on both the full
// and the slim reference and refuses to write anything unless every number matches to the
// bit. That check is the whole point of the file — it is this project's
// 「比较两侧口径不一致会静默失效」 lesson applied to its own build step.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_IDS } from '../../src/lib/reference-store.js';
import { selectCells, calibrateL1Thresholds } from '../../src/probe/cells.js';
import { noiseFloor, validAnswersByCell } from '../../src/stats/noise.js';
import { modelMatrix } from '../../src/layers/model-matrix.js';
import { evaluateL2 } from '../../src/layers/l2-calibrate.js';
import { evaluateL1 } from '../../src/layers/l1-screen.js';
// 🔴 The browser's own reconstruction, imported rather than reimplemented — this script
// exists to prove THAT function is lossless, so a second copy here would prove nothing.
import { rehydrate } from '../src/core/references.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REFERENCE_DIR = path.join(ROOT, 'reference');

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT_DIR = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : path.join(ROOT, 'ui', 'public', 'data');

/** `genuine-gpt-5.6-sol.2026-08-14.json` is a dated backup; the model name itself has dots. */
const DATED_SNAPSHOT = /\.\d{4}-\d{2}-\d{2}$/;

function listReferences(protocol) {
  const dir = path.join(REFERENCE_DIR, protocol);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('genuine-') && f.endsWith('.json'))
    .map((f) => f.slice('genuine-'.length, -'.json'.length))
    .filter((model) => !DATED_SNAPSHOT.test(model))
    .sort()
    .map((model) => ({ model, file: path.join(dir, `genuine-${model}.json`) }));
}

/**
 * The slim form. Everything the browser judges with, nothing it does not.
 *
 * `answers` replaces `samples`: cell → its valid answers in collection order. Non-valid
 * samples are dropped because validAnswersByCell drops them anyway — the reconstruction
 * below is exact for every consumer of `samples` in the judgement path.
 */
function slim(full) {
  const answers = {};
  for (const s of full.samples ?? []) {
    if (s.answer_class !== 'valid' || s.normalized == null) continue;
    (answers[s.cell] ??= []).push(String(s.normalized));
  }
  return {
    model: full.model,
    source_label: full.source_label ?? null,
    genuineness_basis: full.genuineness_basis ?? null,
    collected_utc: full.collected_utc ?? null,
    fingerprint_protocol: full.fingerprint_protocol ?? 'chat',
    fingerprint_params: full.fingerprint_params ?? null,
    normalisation: full.normalisation ?? null,
    battery: full.battery ?? null,
    reps: full.reps ?? 30,
    cells: full.cells ?? Object.keys(full.fingerprint ?? {}),
    fingerprint: full.fingerprint ?? {},
    valid_rate: full.valid_rate ?? null,
    reasoning_rate: full.reasoning_rate ?? null,
    answers,
  };
}

/* ── the self-check ─────────────────────────────────────────────────────────── */

let failures = 0;
const eq = (label, a, b) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    failures += 1;
    console.error(`  ✗ ${label}\n      full: ${String(sa).slice(0, 200)}\n      slim: ${String(sb).slice(0, 200)}`);
  }
  return sa === sb;
};

/** Deterministic pseudo-run built from a reference, so evaluateL1/L2 have real input. */
function syntheticSamples(ref, selection) {
  const byCell = validAnswersByCell(ref.samples ?? []);
  const out = [];
  for (const c of selection.cells) {
    const pool = byCell[c.cell] ?? [];
    for (let i = 0; i < selection.repsPerCell; i += 1) {
      out.push({
        task_id: c.task_id, lang: c.lang, state: 'valid',
        normalized: pool[i % Math.max(1, pool.length)] ?? '0',
        answer_class: 'valid', attempts: 1, kind: 'fingerprint',
      });
    }
  }
  return out;
}

function checkPair(fullA, fullB, leanA, leanB) {
  const hydA = rehydrate(leanA);
  const hydB = rehydrate(leanB);
  const tag = `${fullA.model} vs ${fullB.model}`;

  for (const reps of [5, 15, 30]) {
    eq(`${tag}: noiseFloor @${reps} reps`,
      noiseFloor(validAnswersByCell(fullA.samples ?? []), reps, { trials: 400 }),
      noiseFloor(validAnswersByCell(hydA.samples), reps, { trials: 400 }));
  }

  for (const tier of ['l1', 'l2']) {
    const selFull = selectCells(fullA, fullB, { tier });
    const selLean = selectCells(hydA, hydB, { tier });
    eq(`${tag}: selectCells ${tier}`, selFull, selLean);

    if (tier === 'l1') {
      eq(`${tag}: calibrateL1Thresholds`,
        calibrateL1Thresholds(fullA, fullB, selFull),
        calibrateL1Thresholds(hydA, hydB, selLean));

      const samples = syntheticSamples(fullA, selFull);
      const calibration = calibrateL1Thresholds(fullA, fullB, selFull);
      eq(`${tag}: evaluateL1 end-to-end`,
        evaluateL1({ samples, refSubject: fullA, selection: selFull, calibration }),
        evaluateL1({ samples, refSubject: hydA, selection: selLean, calibration }));
    } else {
      // Both sides sampled and control-free: the two paths take different branches and
      // only the first one touches `samples` on the control reference.
      const subjectSamples = syntheticSamples(fullA, selFull);
      const controlSamples = syntheticSamples(fullB, selFull);
      for (const [label, ctrl] of [['with control', controlSamples], ['--no-control', null]]) {
        eq(`${tag}: evaluateL2 ${label}`,
          evaluateL2({ subjectSamples, controlSamples: ctrl, refSubject: fullA, refControl: fullB, selection: selFull }),
          evaluateL2({ subjectSamples, controlSamples: ctrl, refSubject: hydA, refControl: hydB, selection: selLean }));
      }
    }
  }
}

/* ── build ──────────────────────────────────────────────────────────────────── */

const bundle = {};
const matrices = {};

for (const protocol of PROTOCOL_IDS) {
  const entries = listReferences(protocol);
  if (!entries.length) {
    console.log(`${protocol}: no references, skipping`);
    continue;
  }
  const fulls = entries.map((e) => JSON.parse(readFileSync(e.file, 'utf8')));
  const leans = fulls.map(slim);

  const declared = fulls.filter((f) => (f.fingerprint_protocol ?? 'chat') !== protocol);
  if (declared.length) {
    console.error(`  ✗ ${protocol}: ${declared.map((f) => f.model).join(', ')} declare another protocol`);
    failures += 1;
  }

  console.log(`${protocol}: ${entries.length} references — ${entries.map((e) => e.model).join(', ')}`);

  // Every ORDERED pair: selectCells and the L1 calibration are asymmetric (the subject
  // supplies the noise pool), so checking each unordered pair once would leave half the
  // reference files never exercised as a subject.
  for (let i = 0; i < fulls.length; i += 1) {
    for (let j = 0; j < fulls.length; j += 1) {
      if (i === j) continue;
      checkPair(fulls[i], fulls[j], leans[i], leans[j]);
    }
  }

  // The model map ships precomputed: it is 400 resampling trials per model and never
  // changes between runs, so making every visitor's browser recompute it would be pure
  // waste. The check keeps it honest against the slim inputs the browser would use.
  const mFull = modelMatrix(fulls, { trials: 400 });
  const mLean = modelMatrix(leans.map(rehydrate), { trials: 400 });
  eq(`${protocol}: modelMatrix`, mFull, mLean);

  bundle[protocol] = leans;
  matrices[protocol] = {
    ...mLean,
    collected: leans.map((r) => r.collected_utc),
    reps: leans.map((r) => r.reps),
    cell_counts: leans.map((r) => Object.keys(r.fingerprint).length),
  };
}

if (failures) {
  console.error(`\n✗ ${failures} mismatch(es) between the full and slim references — nothing written.\n` +
                `  The slim form is supposed to be the same measurement. Fix ui/scripts/build-data.js\n` +
                `  (or ui/src/core/references.js, which must rehydrate identically) before shipping.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const write = (name, value) => {
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(value));
  return `${path.relative(ROOT, file)}  ${(Buffer.byteLength(JSON.stringify(value)) / 1024).toFixed(0)}KB`;
};

console.log('');
console.log(`  ✓ every judgement path matches to the bit`);
console.log(`  ${write('references.json', bundle)}`);
console.log(`  ${write('model-matrix.json', matrices)}`);

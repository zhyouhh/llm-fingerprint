#!/usr/bin/env node
// Re-judge an existing L1 result file. ZERO new requests.
//
// This is the 重跑边界 promise being cashed in: the file holds every raw answer, and
// meta records which reference version, which cells, how many reps and which thresholds
// produced the verdict — so a fix to the judging path can be applied to data already
// paid for. The first real use was a normalisation-mismatch bug that voided a whole
// screening round; re-judging cost nothing instead of another 60 requests.
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeRecords } from '../src/normalize/index.js';
import { SAMPLE_KIND, classifySample, makeSample, VERDICT } from '../src/contracts.js';
import { selectCells, calibrateL1Thresholds, combineThresholds } from '../src/probe/cells.js';
import { genuineScreenScores } from '../src/layers/genuine-history.js';
import { loadEndpoints } from '../src/lib/config.js';

const GENUINE = loadEndpoints().find((e) => e.genuine);
import { evaluateL1 } from '../src/layers/l1-screen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'var', 'runs');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const load = (m) => JSON.parse(readFileSync(path.join(ROOT, 'reference', `genuine-${m}.json`), 'utf8'));

const files = readdirSync(RUNS).filter((f) => f.includes('__l1__')).sort();
const latest = new Map();
for (const f of files) latest.set(f.split('__')[0], f);   // keep the newest per endpoint

console.log('re-judging L1 runs from disk — 0 new requests\n');
console.log('endpoint     valid   S_screen    verdict');
console.log('─'.repeat(62));

for (const [id, file] of latest) {
  if (only.length && !only.includes(id)) continue;
  const j = JSON.parse(readFileSync(path.join(RUNS, file), 'utf8'));
  const subject = j.meta.model;
  const control = j.meta.control ?? 'gpt-5.4';
  const refSubject = load(subject);
  const refControl = load(control);

  const selection = selectCells(refSubject, refControl, { tier: 'l1' });
  const calibration = combineThresholds(
    calibrateL1Thresholds(refSubject, refControl, selection),
    GENUINE ? genuineScreenScores({ endpointId: GENUINE.id, model: subject, referenceVersion: refSubject.collected_utc }) : []);

  // Re-normalise from the stored raw text with the corrected pass.
  const normalised = normalizeRecords(j.samples, { applyReasoningTrace: false });
  const samples = normalised.map((rec) => makeSample({
    ...rec,
    kind: SAMPLE_KIND.FINGERPRINT,
    state: classifySample(SAMPLE_KIND.FINGERPRINT, { error: rec.error, answer_class: rec.answer_class }),
    attempts: rec.attempts,
  }));

  const r = evaluateL1({ samples, refSubject, selection, calibration });
  const mark = { [VERDICT.CONSISTENT]: '✅', [VERDICT.SUSPECT]: '🔴', [VERDICT.INCONCLUSIVE]: '⚠️ ', [VERDICT.NOT_APPLICABLE]: '✗ ' }[r.verdict];
  console.log(
    `${id.padEnd(12)} ${(r.valid_rate * 100).toFixed(0).padStart(3)}%   ` +
    `${(r.s_screen != null ? r.s_screen.toFixed(6) : '—').padStart(9)}   ${mark} ${r.verdict}`,
  );
  if (r.per_cell) for (const [c, v] of Object.entries(r.per_cell)) console.log(`               ${c.padEnd(20)} ${v.toFixed(6)}`);
  if (r.reason) console.log(`               ${r.reason}`);
}
console.log(`\nT_pass ${calibrationHint()}`);
function calibrationHint() {
  const refSubject = load('gpt-5.6-sol'); const refControl = load('gpt-5.4');
  const sel = selectCells(refSubject, refControl, { tier: 'l1' });
  const cal = combineThresholds(calibrateL1Thresholds(refSubject, refControl, sel),
    GENUINE ? genuineScreenScores({ endpointId: GENUINE.id, model: 'gpt-5.6-sol', referenceVersion: refSubject.collected_utc }) : []);
  return `${cal.t_pass.toFixed(6)} (${cal.t_pass_basis})   T_fail ${cal.t_fail.toFixed(6)}`;
}

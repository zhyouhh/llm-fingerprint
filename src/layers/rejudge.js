// Re-judge a stored run under the CURRENT calibration.
//
// 🔴 A result file records the verdict that was reached when it was collected. That
// verdict ages: the reference gets refreshed, the threshold gets recalibrated, a bug in
// the judging path gets fixed. Reading it back verbatim reports conclusions the project
// no longer holds — the comparison table did exactly that and disagreed with itself.
//
// The samples do not age. Judging from them under today's calibration is what the
// 重跑边界 promise is for, and it costs nothing.

import { normalizeRecords } from '../normalize/index.js';
import { SAMPLE_KIND, classifySample, makeSample } from '../contracts.js';
import { selectCells, calibrateL1Thresholds, combineThresholds } from '../probe/cells.js';
import { loadReference, loadAllReferences, DEFAULT_PROTOCOL } from '../lib/reference-store.js';
import { evaluateL1 } from './l1-screen.js';
import { evaluateL2 } from './l2-calibrate.js';
import { genuineScreenScores } from './genuine-history.js';

/** Stored rows → the sample shape the evaluators expect, re-normalised under today's pass. */
function restoreSamples(rows) {
  return normalizeRecords(rows, { applyReasoningTrace: false }).map((rec) => makeSample({
    ...rec,
    kind: SAMPLE_KIND.FINGERPRINT,
    state: classifySample(SAMPLE_KIND.FINGERPRINT, { error: rec.error, answer_class: rec.answer_class }),
    attempts: rec.attempts,
  }));
}

/**
 * @param {object} file  a parsed l1 result file
 * @returns {object} the file with `result` recomputed, plus `rejudged: true`
 */
export function rejudgeL1(file) {
  const subject = file.meta?.model;
  const control = file.meta?.control ?? 'gpt-5.4';
  if (!subject) return file;

  // 🔴 Re-judge on the wire the run was collected over, not on whichever reference happens
  // to be on disk. Runs predating the split carry no field and are chat by construction.
  const fpProtocol = file.meta?.fingerprint_protocol ?? DEFAULT_PROTOCOL;
  const refSubject = loadReference(subject, fpProtocol);
  const refControl = loadReference(control, fpProtocol);
  const selection = selectCells(refSubject, refControl, { tier: 'l1' });
  // 🔴 Which endpoint's live screens may widen T_pass is a property of THE REFERENCE, not
  // a global setting: those screens are only a sample of the genuine spread because they
  // are the reference's own source measured against itself. Reading it from a config flag
  // meant that moving the flag — as the switch to the official API does — silently
  // emptied the empirical calibration for the other wire, dropping T_pass back to the
  // simulated value that rejected the genuine endpoint two runs in five.
  const calibration = combineThresholds(
    calibrateL1Thresholds(refSubject, refControl, selection),
    genuineScreenScores({
      endpointId: refSubject.source_label, model: subject,
      referenceVersion: refSubject.collected_utc, fingerprintProtocol: fpProtocol,
    }),
  );

  // Re-normalise from the stored raw answers under the pass that matches reference/.
  const samples = restoreSamples(file.samples);

  return {
    ...file,
    result: evaluateL1({ samples, refSubject, selection, calibration }),
    rejudged: true,
    meta: { ...file.meta, t_pass: calibration.t_pass, t_fail: calibration.t_fail, t_pass_basis: calibration.t_pass_basis },
  };
}

/**
 * The same promise, one tier up. L2 had no re-judging path at all, so every fix to the
 * verdict logic left 180 already-paid-for probes per endpoint stranded at the conclusion
 * they happened to reach on the day — and the comparison table read those stored verdicts
 * verbatim, which is the exact failure L1's rejudge was written to end.
 *
 * @param {object} file  a parsed l2 result file
 * @returns {object} the file with `result` recomputed, plus `rejudged: true`
 */
export function rejudgeL2(file) {
  const subject = file.meta?.model;
  const control = file.meta?.control;
  if (!subject || !control || !Array.isArray(file.meta?.cells)) return file;

  const fpProtocol = file.meta?.fingerprint_protocol ?? DEFAULT_PROTOCOL;
  const refSubject = loadReference(subject, fpProtocol);
  const refControl = loadReference(control, fpProtocol);

  const samples = restoreSamples(file.samples);
  // The two sides are stored in one array and are told apart by `model` — the same split
  // evaluateL2 needs in order to keep two denominators (判定语义④).
  //
  // 🔴 A run collected with --no-control has no control rows, and filtering for them
  // yields an EMPTY ARRAY — which reads as "the control answered nothing" and drove the
  // whole run to not_applicable. "Not sampled" has to survive the round trip as null, so
  // it comes off the meta rather than being inferred from the absence of rows.
  const sampledControl = file.meta.sampled_control !== false;
  const subjectSamples = samples.filter((s) => s.model === subject);
  const controlSamples = sampledControl ? samples.filter((s) => s.model === control) : null;

  const selection = {
    cells: file.meta.cells.map((cell) => {
      const [task_id, lang] = cell.split('|');
      return { cell, task_id, lang };
    }),
    repsPerCell: file.meta.reps_per_cell,
  };

  return {
    ...file,
    result: {
      // 🔴 The whole library, not the two references this run happened to sample. Re-judging
      // means "by TODAY's yardstick", and today's yardstick includes every model collected
      // since — which is exactly how a run stored before a candidate existed gets named.
      ...evaluateL2({
        subjectSamples, controlSamples, refSubject, refControl, selection,
        refs: loadAllReferences(fpProtocol),
      }),
      // Not part of the verdict; carried through so the report keeps its effort proxy.
      reasoning_rate: file.result?.reasoning_rate ?? null,
    },
    rejudged: true,
  };
}

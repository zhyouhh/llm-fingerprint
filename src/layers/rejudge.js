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
import { loadReference, DEFAULT_PROTOCOL } from '../lib/reference-store.js';
import { evaluateL1 } from './l1-screen.js';
import { genuineScreenScores } from './genuine-history.js';

/**
 * @param {object} file  a parsed l1 result file
 * @param {{genuineEndpointId?: string}} [opts]
 * @returns {object} the file with `result` recomputed, plus `rejudged: true`
 */
export function rejudgeL1(file, { genuineEndpointId = null } = {}) {
  const subject = file.meta?.model;
  const control = file.meta?.control ?? 'gpt-5.4';
  if (!subject) return file;

  // 🔴 Re-judge on the wire the run was collected over, not on whichever reference happens
  // to be on disk. Runs predating the split carry no field and are chat by construction.
  const fpProtocol = file.meta?.fingerprint_protocol ?? DEFAULT_PROTOCOL;
  const refSubject = loadReference(subject, fpProtocol);
  const refControl = loadReference(control, fpProtocol);
  const selection = selectCells(refSubject, refControl, { tier: 'l1' });
  const calibration = combineThresholds(
    calibrateL1Thresholds(refSubject, refControl, selection),
    genuineEndpointId
      ? genuineScreenScores({
        endpointId: genuineEndpointId, model: subject,
        referenceVersion: refSubject.collected_utc, fingerprintProtocol: fpProtocol,
      })
      : [],
  );

  // Re-normalise from the stored raw answers under the pass that matches reference/.
  const normalised = normalizeRecords(file.samples, { applyReasoningTrace: false });
  const samples = normalised.map((rec) => makeSample({
    ...rec,
    kind: SAMPLE_KIND.FINGERPRINT,
    state: classifySample(SAMPLE_KIND.FINGERPRINT, { error: rec.error, answer_class: rec.answer_class }),
    attempts: rec.attempts,
  }));

  return {
    ...file,
    result: evaluateL1({ samples, refSubject, selection, calibration }),
    rejudged: true,
    meta: { ...file.meta, t_pass: calibration.t_pass, t_fail: calibration.t_fail, t_pass_basis: calibration.t_pass_basis },
  };
}

// L2 — the calibrated comparison. 180 probes, and the only layer that can separate
// "different harness" from "different model".
//
// Two gateways wrap requests differently, so a raw cross-endpoint distance conflates the
// two. The fix is to also sample a CONTROL model that both sides serve and that is
// independently known to be genuine on both:
//
//   H  control, reference ↔ relay     pure harness effect (the model is the same)
//   S  subject, reference ↔ relay     what we are judging
//   D  subject ↔ control, on the relay itself   the scale a real substitution produces
//
// S is judged against H, never against an absolute threshold. S ≈ H means the harness
// explains the whole gap. S approaching D means the gap is the size of a different
// model.

import {
  VERDICT, makeCollection, makeL2Result, assertL2Result, l2Rates, L2_LOGICAL_SAMPLES_PER_SIDE,
} from '../contracts.js';
import { jsd } from '../stats/jsd.js';
import { noiseFloor, correct, validAnswersByCell } from '../stats/noise.js';
import { ratioCI } from '../stats/bootstrap.js';
import { applyGates, usableCells, L2_MIN_N } from '../stats/guards.js';
import { selectCells } from '../probe/cells.js';
import { runBattery } from '../probe/runner.js';

/** S ≤ 1.5 × H means the harness accounts for it. */
export const CONSISTENT_RATIO = 1.5;
/** S ≥ 0.7 × D means the gap is approaching the different-model scale. */
export const SUSPECT_RATIO = 0.7;

/** Per-cell empirical distribution from valid samples. */
function fingerprintOf(samples) {
  const counts = {};
  for (const s of samples) {
    if (s.state !== 'valid' || s.normalized == null) continue;
    const cell = `${s.task_id}|${s.lang}`;
    (counts[cell] ??= {})[s.normalized] = ((counts[cell] ?? {})[s.normalized] ?? 0) + 1;
  }
  const out = {};
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    out[cell] = { dist: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n])), n };
  }
  return out;
}

function perCellJsd(a, b, cells) {
  const out = {};
  for (const cell of cells) {
    const x = a[cell]?.dist ?? a[cell];
    const y = b[cell]?.dist ?? b[cell];
    if (x && y) out[cell] = jsd(x, y);
  }
  return out;
}

const meanOf = (obj) => {
  const v = Object.values(obj);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};

/**
 * Judge an already-collected calibration. Pure, zero requests.
 *
 * @param {{subjectSamples, controlSamples, refSubject, refControl, selection}} args
 */
export function evaluateL2({ subjectSamples, controlSamples, refSubject, refControl, selection }) {
  // 🔴 Two sides, two denominators, two separate gate passes (判定语义④). A merged 180
  // would let subject-fine/control-dead compute to 50% and sail through while H and D
  // are both meaningless.
  const r = l2Rates({ subjectSamples, controlSamples });

  const subjectFp = fingerprintOf(subjectSamples);
  const controlFp = fingerprintOf(controlSamples);
  const counts = {};
  for (const cell of new Set([...Object.keys(subjectFp), ...Object.keys(controlFp)])) {
    counts[cell] = Math.min(subjectFp[cell]?.n ?? 0, controlFp[cell]?.n ?? 0);
  }
  const { live, dropped } = usableCells(counts, { minN: L2_MIN_N });

  const base = {
    subject: r.subject, control: r.control, live_cells: live.length,
    h: NaN, s: NaN, d: NaN, h_c: NaN, s_c: NaN, d_c: NaN,
    ratio: NaN, ratio_ci_lo: NaN, ratio_ci_hi: NaN, noise_floor: NaN, low_confidence: false,
  };

  for (const side of ['subject', 'control']) {
    const gate = applyGates({
      tier: 'l2', validRate: r[side].valid_rate,
      liveCells: live.length, requestedCells: selection.cells.length,
    });
    if (gate.verdict === VERDICT.NOT_APPLICABLE) {
      return assertL2Result(makeL2Result({ ...base, verdict: gate.verdict, reason: `${side}: ${gate.reason}` }));
    }
  }
  const gate = applyGates({
    tier: 'l2', validRate: Math.min(r.subject.valid_rate, r.control.valid_rate),
    liveCells: live.length, requestedCells: selection.cells.length,
  });
  if (gate.verdict) {
    return assertL2Result(makeL2Result({ ...base, verdict: gate.verdict, reason: gate.reason }));
  }

  const hPer = perCellJsd(refControl.fingerprint, controlFp, live);
  const sPer = perCellJsd(refSubject.fingerprint, subjectFp, live);
  const dPer = perCellJsd(subjectFp, controlFp, live);

  // One floor, measured at this tier's reps. Roughly a third of every raw distance
  // recorded on this project was this artefact.
  const floor = noiseFloor(validAnswersByCell(refSubject.samples ?? []), selection.repsPerCell,
    { trials: 400 }).overall;
  const h = meanOf(hPer);
  const s = meanOf(sPer);
  const d = meanOf(dPer);
  const [h_c, s_c, d_c] = [correct(h, floor), correct(s, floor), correct(d, floor)];

  const ci = ratioCI(sPer, hPer);

  const withNumbers = {
    ...base, h, s, d, h_c, s_c, d_c, noise_floor: floor,
    ratio: ci.ratio, ratio_ci_lo: ci.lo, ratio_ci_hi: ci.hi,
    per_cell: { h: hPer, s: sPer, d: dPer }, dropped_cells: dropped,
    low_confidence: gate.lowConfidence,
  };

  // 🔴 The ratio tests only mean anything while H_c is meaningfully positive. When the
  // control model is near-identical on both sides — self-comparison, or two gateways
  // that happen to wrap alike — S_c ≤ 1.5 × H_c degenerates into 0 ≤ 0 and the
  // bootstrap interval spreads to nonsense. That is "this run measured nothing", not
  // "consistent", and calling it consistent would be the most dangerous false green
  // this tool could produce.
  if (!(h_c > floor * 0.25)) {
    return assertL2Result(makeL2Result({
      ...withNumbers, verdict: VERDICT.INCONCLUSIVE,
      reason: `harness term H_c (${h_c.toFixed(4)}) is not meaningfully above the noise floor ` +
              `(${floor.toFixed(4)}) — the ratio tests have no denominator to work with`,
    }));
  }

  let verdict;
  let reason = null;
  if (s_c <= CONSISTENT_RATIO * h_c && ci.hi < CONSISTENT_RATIO) {
    verdict = VERDICT.CONSISTENT;
  } else if (d_c > 0 && s_c >= SUSPECT_RATIO * d_c) {
    verdict = VERDICT.SUSPECT;
  } else {
    verdict = VERDICT.INCONCLUSIVE;
    reason = s_c <= CONSISTENT_RATIO * h_c
      ? `point estimate passes but the 90% interval reaches ${ci.hi.toFixed(2)} — add reps or cells`
      : 'between the harness scale and the different-model scale — add reps or cells';
  }

  return assertL2Result(makeL2Result({ ...withNumbers, verdict, reason }));
}

/**
 * Collect both sides and judge. 180 logical probes: 6 live cells × 15 reps × 2 models.
 */
export async function calibrateL2({ probe, subject, control, refSubject, refControl, onProgress }) {
  const selection = selectCells(refSubject, refControl, { tier: 'l2' });

  const collect = (model, role) => runBattery({
    probe, model, cells: selection.cells, reps: selection.repsPerCell, role,
    applyReasoningTrace: false,   // matches how reference/ was collected
    onProgress: onProgress && ((p) => onProgress({ ...p, model })),
  });

  const subjectRun = await collect(subject, 'subject');
  const controlRun = await collect(control, 'control');

  const result = evaluateL2({
    subjectSamples: subjectRun.samples, controlSamples: controlRun.samples,
    refSubject, refControl, selection,
  });

  const samples = [...subjectRun.samples, ...controlRun.samples];
  return makeCollection({
    result: {
      ...result,
      reasoning_rate: { subject: subjectRun.reasoningRate, control: controlRun.reasoningRate },
    },
    samples,
    meta: {
      tier: 'l2', model: subject, control,
      reference_version: refSubject.collected_utc ?? 'unknown',
      cells: selection.cells.map((c) => c.cell),
      reps_per_cell: selection.repsPerCell,
      logical_per_side: L2_LOGICAL_SAMPLES_PER_SIDE,
    },
  });
}

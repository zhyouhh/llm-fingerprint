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
  VERDICT, makeCollection, makeL2Result, assertL2Result, l2Rates, l2LogicalPerSide,
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
 * `controlSamples: null` means the control model was deliberately not sampled. That halves
 * the probe budget, and on a wire where the harness turns out to be negligible it costs
 * almost nothing: H_c measured 0.025 and 0.002 against the official reference — both under
 * the noise floor, so the denominator was already falling back to the floor anyway.
 *
 * 🔴 What it DOES cost: without a control there is no measurement of the harness, so a
 * gateway that really does distort answers would have that distortion attributed to the
 * model. That is not hypothetical — on the chat wire H_c was 0.33. The saving is only safe
 * on a wire where the harness has been measured small, and the result says which it was.
 *
 * @param {{subjectSamples, controlSamples, refSubject, refControl, selection}} args
 */
export function evaluateL2({ subjectSamples, controlSamples, refSubject, refControl, selection }) {
  const sampledControl = controlSamples !== null;
  // 🔴 Two sides, two denominators, two separate gate passes (判定语义④). One merged
  // denominator would let subject-fine/control-dead compute to 50% and sail through while
  // H and D are both meaningless.
  const r = l2Rates({ subjectSamples, controlSamples, logicalPerSide: l2LogicalPerSide(selection) });

  const subjectFp = fingerprintOf(subjectSamples);
  const controlFp = sampledControl ? fingerprintOf(controlSamples) : null;
  const counts = {};
  for (const cell of Object.keys(subjectFp)) {
    counts[cell] = sampledControl
      ? Math.min(subjectFp[cell]?.n ?? 0, controlFp[cell]?.n ?? 0)
      : (subjectFp[cell]?.n ?? 0);
  }
  const { live, dropped } = usableCells(counts, { minN: L2_MIN_N });

  const base = {
    subject: r.subject, control: r.control, live_cells: live.length,
    h: NaN, s: NaN, d: NaN, h_c: NaN, s_c: NaN, d_c: NaN,
    ratio: NaN, ratio_ci_lo: NaN, ratio_ci_hi: NaN,
    sd_ratio: NaN, sd_ci_lo: NaN, sd_ci_hi: NaN, denominator_basis: null,
    noise_floor: NaN, low_confidence: false,
  };

  const sides = sampledControl ? ['subject', 'control'] : ['subject'];
  for (const side of sides) {
    const gate = applyGates({
      tier: 'l2', validRate: r[side].valid_rate,
      liveCells: live.length, requestedCells: selection.cells.length,
    });
    if (gate.verdict === VERDICT.NOT_APPLICABLE) {
      return assertL2Result(makeL2Result({ ...base, verdict: gate.verdict, reason: `${side}: ${gate.reason}` }));
    }
  }
  const gate = applyGates({
    tier: 'l2',
    validRate: Math.min(...sides.map((side) => r[side].valid_rate)),
    liveCells: live.length, requestedCells: selection.cells.length,
  });
  if (gate.verdict) {
    return assertL2Result(makeL2Result({ ...base, verdict: gate.verdict, reason: gate.reason }));
  }

  const sPer = perCellJsd(refSubject.fingerprint, subjectFp, live);
  // Without a control on the relay there is no harness measurement: H is treated as zero
  // and the noise floor carries the denominator (see the ratioCI options below).
  const hPer = sampledControl
    ? perCellJsd(refControl.fingerprint, controlFp, live)
    : Object.fromEntries(live.map((c) => [c, 0]));
  // 🔴 D is the yardstick for "what a different model looks like". Measured on the relay it
  // is contaminated by whatever the relay is doing; taken from the two references it is a
  // property of the model PAIR, measured on ground truth, and costs nothing.
  const dPer = sampledControl
    ? perCellJsd(subjectFp, controlFp, live)
    : perCellJsd(refSubject.fingerprint, refControl.fingerprint, live);

  // One floor, measured at this tier's reps. Roughly a third of every raw distance
  // recorded on this project was this artefact.
  const floor = noiseFloor(validAnswersByCell(refSubject.samples ?? []), selection.repsPerCell,
    { trials: 400 }).overall;
  const h = meanOf(hPer);
  const s = meanOf(sPer);
  const d = meanOf(dPer);
  const [h_c, s_c, d_c] = [correct(h, floor), correct(s, floor), correct(d, floor)];

  // 🔴 The denominator gets a floor. A harness term below the noise floor is not a failed
  // measurement — it is a measured absence: the control model came back indistinguishable
  // on both sides, which is the BEST case a control can produce. The old code read that as
  // "this run measured nothing" and abandoned the run, throwing away relay-C's S_c/D_c = 0.07
  // (a subject seven per cent of the way to the different-model scale) as unjudgeable.
  //
  // What actually breaks in that regime is the ratio, not the evidence. So the question
  // becomes: is the gap explained by the harness, OR is it inside what the measurement can
  // resolve at all — whichever is more generous. Below the floor there is nothing left to
  // explain either way.
  const denominatorBasis = !sampledControl
    ? 'noise floor (control not sampled)'
    : (h_c >= floor ? 'harness' : 'noise floor');

  // Both intervals describe exactly the quantity their test compares — same correction,
  // same floor, one definition (see stats/bootstrap.js). `denomFloor` is where the
  // flooring actually happens; there is no second copy of it in the verdict below.
  const ciOpts = { correctBy: floor, denomFloor: floor };
  const ci = ratioCI(sPer, hPer, ciOpts);
  const ciSD = ratioCI(sPer, dPer, ciOpts);

  const withNumbers = {
    ...base, h, s, d, h_c, s_c, d_c, noise_floor: floor,
    ratio: ci.ratio, ratio_ci_lo: ci.lo, ratio_ci_hi: ci.hi,
    sd_ratio: ciSD.ratio, sd_ci_lo: ciSD.lo, sd_ci_hi: ciSD.hi,
    denominator_basis: denominatorBasis,
    per_cell: { h: hPer, s: sPer, d: dPer }, dropped_cells: dropped,
    low_confidence: gate.lowConfidence,
  };

  // 🔴 One symmetric rule: a verdict needs its WHOLE interval on the right side of the
  // line. Consistent when the interval sits entirely below the harness line, suspect when
  // it sits entirely above the different-model line, otherwise inconclusive.
  //
  // Only `consistent` used to carry that requirement — `suspect` convicted on a point
  // estimate. The asymmetry ran the wrong way for this tool: the expensive error is
  // accusing an honest relay, yet acquittal needed an interval and conviction did not.
  // Two runs of one endpoint an hour apart landed at S_c/D_c 1.04 and 0.64 and were
  // written up as "suspect" and "inconclusive" — one sample either side of a line
  // neither run could resolve.
  //
  // The old point tests are gone rather than kept as belt-and-braces: with the interval
  // now describing the same quantity, `s_c ≤ 1.5 × denom` is exactly `ci.ratio ≤ 1.5`,
  // which `ci.hi < 1.5` already implies. They could not fail, and a rule with a clause
  // that cannot fail invites the reader to trust the wrong clause.

  // D is the yardstick for "what a different model looks like". Inside the noise floor it
  // is not a yardstick — that happens when the relay answers the same for both model
  // names, which is its own kind of alarming but is not something S/D can measure.
  const scaleUsable = d_c >= floor;

  let verdict;
  let reason = null;
  if (ci.hi < CONSISTENT_RATIO) {
    verdict = VERDICT.CONSISTENT;
    if (denominatorBasis === 'noise floor') {
      reason = `the harness term is below the noise floor (${floor.toFixed(4)}), so the gap is judged ` +
               `against the floor itself: S_c ${s_c.toFixed(4)} is inside what this many samples resolve`;
    }
  } else if (scaleUsable && ciSD.lo >= SUSPECT_RATIO) {
    verdict = VERDICT.SUSPECT;
  } else {
    verdict = VERDICT.INCONCLUSIVE;
    reason = !scaleUsable
      ? `⚠️ this relay answers alike for BOTH model names: the different-model scale D_c ` +
        `(${d_c.toFixed(4)}) is inside the noise floor (${floor.toFixed(4)}), while the reference ` +
        `endpoint tells the two apart. That is alarming in itself — but it also removes the ` +
        `scale a substitution would be measured against, so this is not a verdict. Screen the ` +
        `control model in its own right to find out which of the two names is being served.`
      : ciSD.ratio >= SUSPECT_RATIO
        ? `S_c/D_c point estimate ${ciSD.ratio.toFixed(2)} clears ${SUSPECT_RATIO} but the 90% ` +
          `interval falls to ${ciSD.lo.toFixed(2)} — not enough to accuse. Add reps or cells.`
        : `between the harness scale (S/H ${ci.ratio.toFixed(2)}, needs its whole interval below ` +
          `${CONSISTENT_RATIO}; reaches ${ci.hi.toFixed(2)}) and the different-model scale ` +
          `(S/D ${ciSD.ratio.toFixed(2)}, needs ≥ ${SUSPECT_RATIO}) — add reps or cells`;
  }

  return assertL2Result(makeL2Result({ ...withNumbers, verdict, reason }));
}

/**
 * Collect both sides and judge. 180 logical probes: 6 live cells × 15 reps × 2 models.
 */
export async function calibrateL2({ probe, subject, control, refSubject, refControl, fpProtocol,
                                    sampleControl = true, concurrency, onProgress }) {
  // 🔴 Explicit, for the same reason screenL1 demands it: the stored file has to say which
  // wire produced it, or a later reader cannot tell which reference it was ever comparable
  // with.
  if (typeof fpProtocol !== 'string') {
    throw new Error('calibrateL2: fpProtocol must be passed explicitly — it is recorded in meta and ' +
                    'identifies which reference these numbers are comparable with.');
  }
  const selection = selectCells(refSubject, refControl, { tier: 'l2' });

  const collect = (model, role) => runBattery({
    probe, model, cells: selection.cells, reps: selection.repsPerCell, role,
    ...(concurrency ? { concurrency } : {}),
    applyReasoningTrace: false,   // matches how reference/ was collected
    onProgress: onProgress && ((p) => onProgress({ ...p, model })),
  });

  const subjectRun = await collect(subject, 'subject');
  const controlRun = sampleControl ? await collect(control, 'control') : null;

  const result = evaluateL2({
    subjectSamples: subjectRun.samples,
    controlSamples: controlRun ? controlRun.samples : null,
    refSubject, refControl, selection,
  });

  const samples = [...subjectRun.samples, ...(controlRun?.samples ?? [])];
  return makeCollection({
    result: {
      ...result,
      reasoning_rate: { subject: subjectRun.reasoningRate, control: controlRun?.reasoningRate ?? null },
    },
    samples,
    meta: {
      tier: 'l2', model: subject, control,
      fingerprint_protocol: fpProtocol,
      reference_version: refSubject.collected_utc ?? 'unknown',
      cells: selection.cells.map((c) => c.cell),
      reps_per_cell: selection.repsPerCell,
      logical_per_side: l2LogicalPerSide(selection),
      sampled_control: sampleControl,
    },
  });
}

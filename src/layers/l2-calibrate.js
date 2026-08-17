// L2 — the calibrated comparison: every live cell at 15 reps per side, so a few hundred
// probes on today's forty-cell battery. The layer that separates "different harness" from
// "different model", and the only one that can name what the relay is serving instead.
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
  gateFromValidRate,
} from '../contracts.js';
import { jsd } from '../stats/jsd.js';
import { noiseFloor, correct, validAnswersByCell, pairBias, REFERENCE_MIN_N } from '../stats/noise.js';
import { ratioCI } from '../stats/bootstrap.js';
import { applyGates, usableCells, L2_MIN_N } from '../stats/guards.js';
import { selectCells } from '../probe/cells.js';
import { runBattery } from '../probe/runner.js';
import { identification as identifyAgainst, SEPARATION, RANKING_STABILITY } from './model-matrix.js';

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

/** Whole days since a reference was collected; null when the file does not say. */
export function ageInDays(collectedUtc, now = Date.now()) {
  const t = Date.parse(collectedUtc ?? '');
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
}

/**
 * The oldest of a set of references, in days — or null when that cannot be known.
 *
 * 🔴 A single undated reference makes the whole answer null, not "the oldest of the rest".
 * Skipping the unknowns is a max over a subset reported as a max over the set: an undated
 * winning reference beside a two-day-old defended one came out as "oldest reference in play:
 * 2 days", which is the reassuring half of a fact whose other half is missing. Unknown age is
 * an unknown yardstick, and the reason line says so.
 */
export function oldestAge(refs, now = Date.now()) {
  const present = refs.filter(Boolean);
  if (!present.length) return null;
  const ages = present.map((r) => ageInDays(r.collected_utc, now));
  return ages.some((a) => a == null) ? null : Math.max(...ages);
}

/** Beyond this the defended reference may no longer describe the genuine model. */
export const REFERENCE_STALE_DAYS = 90;

/**
 * One wording for the accusation, so the three places that can reach it cannot drift.
 *
 * ⚠️ It always states the reference's age. The one way this route accuses without a
 * substitution having happened is a reference collected before the vendor updated that
 * model's weights: the honest current model no longer matches its own stored fingerprint,
 * and a sibling reference can be nearer. Nothing in the data distinguishes that from a
 * real swap, so the reader is told how old the yardstick is and left to judge.
 */
function impostorReason(id, sold, stale = false) {
  const age = id.reference_age_days;
  // 🔴 This states the rule that actually ran. It used to say the 90% lower bound "must stay
  // above 1", which no branch checks — a run convicted with `separation_lo` at 0 while the
  // sentence explaining the conviction said that could not happen. What decides is the point
  // separation and `rank_stability`; the lower bound is reported as context, labelled as such.
  return `this distribution is shaped like ${id.model}, not the ${sold} it was sold as: ` +
    `${id.distance.toFixed(4)} away from ${id.model} against ${id.runner_up_distance.toFixed(4)} ` +
    `for the next candidate (${id.runner_up}) — separation ${fmtSep(id.separation)}, past the ` +
    `${SEPARATION}× bar, and ${id.model} stayed the nearest in ` +
    `${(id.rank_stability * 100).toFixed(1)}% of resampled cell draws, past the ` +
    `${(RANKING_STABILITY * 100).toFixed(0)}% bar (those two are what decide; for context the ` +
    `90% lower bound on the separation is ${fmtSep(id.separation_lo)}). Over ${id.cells} shared ` +
    `cells, against a resolution floor of ` +
    `${id.floor.toFixed(4)}. Judged on SEPARATION rather than absolute distance, because the ` +
    `absolute value carries this relay's harness. ` +
    `⚠️ only models the reference library holds can be recognised this way, and this rests on ` +
    `the reference library still describing these models (oldest reference in play: ` +
    `${age == null ? 'unknown' : `${age} days`})` +
    (age == null ? ' (its collection date is unknown).'
      : stale ? ` — and it was collected ${age} days ago, past the ${REFERENCE_STALE_DAYS}-day mark. ` +
        `A silent in-place weight update behind an unchanged model id is rare, but it would look ` +
        `exactly like this. Re-collect the reference if you are going to act on this.`
        : ` (collected ${age} days ago).`);
}

const fmtSep = (sep) => (Number.isFinite(sep) ? `${sep.toFixed(1)}×` : (Number.isNaN(sep) ? 'n/a' : '∞'));

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
 * @param {{subjectSamples, controlSamples, refSubject, refControl, selection, refs}} args
 * @param {Array<{model, fingerprint}>|null} args.refs  the whole genuine library on this
 *   wire, for the identification route. **Explicit, no default** — see below.
 */
export function evaluateL2({ subjectSamples, controlSamples, refSubject, refControl, selection, refs }) {
  // 🔴 No default, for the reason `applyReasoningTrace` has none: the identification route
  // is the ONLY one that convicts a swap to a near neighbour, so a caller that silently
  // omits the library gets a materially weaker verdict and no error. `null` is a legal,
  // deliberate "no library available" and is recorded as such in the result.
  if (refs !== null && !Array.isArray(refs)) {
    throw new Error('evaluateL2: refs must be an array of genuine references, or explicitly null. ' +
      'Omitting it silently drops the only route that catches a same-generation substitution.');
  }
  // 🔴 An empty library is not a library. Allowing it would store `identification: null`,
  // which the contract reserves for "never asked" — and a reader cannot then tell a run
  // that had no candidates from one that was never given any.
  if (Array.isArray(refs) && refs.length === 0) {
    throw new Error('evaluateL2: refs is an empty array. Pass null to say no reference library ' +
      'was available; [] would be stored as "not checked" and hide that there were no candidates.');
  }
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

  // One floor, and it must describe THE COMPARISON THAT RAN. Roughly a third of every raw
  // distance recorded on this project was this artefact, so H, S and D all have it
  // subtracted and S/D divides by it — which makes every way of getting it wrong a way of
  // moving a verdict.
  //
  // 🔴 Two things it used to get wrong, both in the accusing direction:
  //   · averaged over ALL the reference's cells while H/S/D are computed over the LIVE ones
  //     only. Cells excluded from the comparison — dropped for too few samples, or never
  //     selected — still pulled the mean toward whatever their dispersion happened to be,
  //     and a cell the reference measured once contributes a floor of 0. Three live cells
  //     each floored at 0.15, sitting in a battery of forty, reported 0.011; S/D then read
  //     0.74 where the honest calibration says 0.33, and the run came back SUSPECT.
  //   · used the planned `repsPerCell` for every cell, when the live cells are exactly the
  //     ones that came back unevenly.
  const liveSet = new Set(live);
  const keep = (pools) => Object.fromEntries(Object.entries(pools).filter(([c]) => liveSet.has(c)));
  // 🔴 Each side's OWN counts. `counts` is the min of the two, which is the right rule for
  // deciding whether a cell is live and the wrong one for calibrating anything: with the
  // subject at 14 and the control at 15, H's comparison is 15-vs-reference and D's is
  // 14-vs-15, and running all three at 14 mis-scales two of them. Measured on a 40-cell
  // construction the difference is S/H 1.507 vs 1.467 and S/D 0.702 vs 0.696 — SUSPECT
  // against CONSISTENT, on an endpoint whose valid rate is 93%.
  // `controlFp` is null when the control was deliberately not sampled — that branch takes
  // its counts from the reference pools instead, so an absent side must not throw here.
  const repsFrom = (fp) => Object.fromEntries(live.map((c) => [c, fp?.[c]?.n ?? 0]));
  const subjReps = repsFrom(subjectFp);
  const ctlReps = repsFrom(controlFp);
  const subjPools = keep(validAnswersByCell(refSubject.samples ?? []));
  const ctlPools = keep(validAnswersByCell(refControl.samples ?? []));
  const poolSizes = (pools) => Object.fromEntries(Object.entries(pools).map(([c, v]) => [c, v.length]));

  // 🔴 THREE floors, because H, S and D are three different comparisons.
  //
  //   S = this run's subject   vs a stored subject reference   → 15 against the library's 30
  //   H = this run's control   vs a stored control reference   → 15 against the library's 30
  //   D = this run's subject   vs this run's control           → 15 against 15
  //
  // One number cannot calibrate all three, and using the wrong one moves verdicts. This was
  // a single symmetric floor for a long time, which was right for D and wrong for S; wiring
  // `against: 'pool'` in made it right for S and wrong for D, which is worse rather than
  // neutral — measured on a 40-cell construction with S 0.230, D 0.285, H 0, the symmetric
  // floor 0.113 gives S/D 0.680 and CONSISTENT while the pool floor 0.089 gives 0.719 and
  // convicts a genuine endpoint. So each quantity now carries its own.
  //
  // 🔴 …and S and H are SAME-MODEL comparisons while D is a CROSS-model one, which needs a
  // different statistic entirely. Under S's null hypothesis the two sides are the same
  // model, so the whole measured distance is sampling noise and the noise floor IS the
  // correction. D's true value is large and nonzero; only a small bias sits on top of it.
  // Substituting a same-model floor there over-subtracts by more than a factor of ten —
  // measured, P={a:1} against Q={a:25/30,b:5/30} at thirty a side has a true JSD of 0.0888
  // and a bias of 0.00098, while Q's own floor is 0.0134. And the direction is the unsafe
  // one: D is a DENOMINATOR, so over-subtracting shrinks it and raises S/D toward the
  // accusation line. The "take the larger floor" reasoning from `comparisonFloor` does not
  // carry over — there a larger number is more conservative, here it is less.
  // 🔴 A floor that cannot be MEASURED is not a floor of zero, and this path used to read
  // it as one. `noiseFloor({})` returns `overall: 0` by construction and `ratioCI` fills a
  // missing correction key with 0, so a reference carrying a fingerprint but no samples
  // produced "this comparison has no sampling noise at all" — the most confident possible
  // statement, from the least evidence. Reachable without contrivance: `selectCells` will
  // happily plan a run against such a reference, and the CLI's `calibrateL2` does not pass
  // through the UI's floor guard. Constructed, it convicts a genuine endpoint at S/D lower
  // bound 1.0. The identification route already refuses this; the S/H/D route did not.
  // 🔴 The project's own reference bar, not "has at least one sample". A cell the library
  // measured once cannot state its noise any more than a cell it never measured — and
  // `modelFloors` already refuses exactly that pool. Fresh runs filter such cells during
  // selection, but `rejudge` replays the cells a stored run used, so the thin ones come
  // straight back: constructed, a subject reference holding one sample per cell against a
  // genuine 15-sample run reports floor 0, S/D lower bound 1.0, and SUSPECT.
  const cannotCalibrate = (pools) => live.some((c) => (pools[c]?.length ?? 0) < REFERENCE_MIN_N);
  // ⚠️ The control reference is needed EITHER WAY — sampled, it calibrates H; not sampled,
  // it is one half of D's reference-vs-reference comparison — so there is no condition on
  // it. It briefly read `(sampledControl || true) && …`, which is a guard that cannot
  // branch: [[guards-that-cannot-fail]], written in the same round that fixed three others.
  const uncalibratable = live.length
    ? [
      cannotCalibrate(subjPools) ? `${refSubject.model ?? 'subject'} 参照` : null,
      cannotCalibrate(ctlPools) ? `${refControl?.model ?? 'control'} 参照` : null,
    ].filter(Boolean)
    : [];
  const zeroByCell = Object.fromEntries(live.map((c) => [c, 0]));
  const sNoise = live.length
    ? noiseFloor(subjPools, subjReps, { trials: 400, against: 'pool' })
    : { overall: NaN, byCell: zeroByCell };
  const hNoise = sampledControl && live.length
    ? noiseFloor(ctlPools, ctlReps, { trials: 400, against: 'pool' })
    : { overall: 0, byCell: zeroByCell };
  const floorS = sNoise.overall;
  const floorH = hNoise.overall;
  const floorSByCell = sNoise.byCell;
  const floorHByCell = hNoise.byCell;
  // D sampled: this run's subject against this run's control, each at its own count.
  // D not sampled: the two REFERENCES against each other, each at its own banked pool size.
  const dBias = live.length
    ? (sampledControl
      ? pairBias(subjPools, ctlPools, subjReps, ctlReps, { trials: 400 })
      : pairBias(subjPools, ctlPools, poolSizes(subjPools), poolSizes(ctlPools), { trials: 400 }))
    : { overall: NaN, byCell: zeroByCell };
  const floorD = dBias.overall;
  const floorDByCell = dBias.byCell;
  // The headline number stays the SUBJECT's — it is the one a reader is asking about, and
  // it is what `noise_floor` has always meant. The other two travel beside it.
  const floor = floorS;

  // 🔴 Identification runs on the SUBJECT alone, and it runs BEFORE the gates, because the
  // gates are about the control as much as the subject. Placed after them, a control
  // answering nothing but 429 returned `not_applicable` and threw away a perfectly good
  // subject side that named an impostor over twenty-nine strong cells — measured, on two
  // real runs where rate limiting killed 102 and 137 of one side's 420 probes.
  //
  // Its own precondition is the SUBJECT's valid rate: a distribution read off under a
  // fifth of the probes is scraps, and scraps must not carry a name.
  //
  // It uses the subject's own cells rather than `live` for the same reason — `live` is the
  // intersection with the control, and the control has nothing to do with this question.
  const subjectGate = gateFromValidRate(r.subject.valid_rate);
  const subjectUsable = subjectGate !== 'not_applicable';
  const subjectLive = Object.entries(subjectFp).filter(([, v]) => v.n >= L2_MIN_N);
  const measured = Object.fromEntries(subjectLive.map(([cell, v]) => [cell, v.dist]));
  // 🔴 What each cell ACTUALLY got, not what the run planned. The floor answers "how far
  // apart would two runs of this measurement land"; a cell that lost five of its fifteen
  // probes has a wider floor than one that lost none, and `selection.repsPerCell` says
  // fifteen for both. Understating the floor inflates every ratio taken against it, in the
  // direction of accusing — and the cells that lose probes are exactly the ones a
  // rate-limited run thins out.
  const measuredReps = Object.fromEntries(subjectLive.map(([cell, v]) => [cell, v.n]));
  // The name being defended is the reference's own, because that is what `S` is measured
  // against. If it were ever missing, `sold` would be empty, every match would differ from
  // it, and the run would accuse the endpoint of serving the model it does serve.
  if (refs !== null && (typeof refSubject.model !== 'string' || refSubject.model.trim() === '')) {
    throw new Error('evaluateL2: the subject reference carries no usable `model`, so there is ' +
      'nothing to compare an identification against — every match would read as an impostor.');
  }
  const identification = refs === null || !subjectUsable
    ? null
    : identifyAgainst(measured, refs, refSubject.model, {
      reps: measuredReps,
      // 🔴 The thin-run bar lives inside `identification`, not out here. Held out here it
      // guarded only this function's verdict, while `headline()` reads `impostor` before it
      // reads the verdict and both the report and the CLI re-run the identification from
      // the stored samples — so a run withheld at 57% still opened as a red named
      // accusation everywhere a person actually looks.
      validRate: r.subject.valid_rate,
      // 🔴 The OLDEST reference that takes part, not just the defended one. A two-day-old
      // subject reference next to a two-hundred-day-old candidate would have reported
      // "collected 2 days ago" while naming a model off a fingerprint from last year.
      referenceAgeDays: oldestAge([refSubject, ...refs]),
    });

  // ⚠️ A stale yardstick is WARNED about, not treated as a disqualification. A silent
  // in-place weight update behind an unchanged model id is rare — vendors ship a new id —
  // so withholding every verdict past the mark would trade a common true finding for an
  // uncommon confound. The age travels with the result and the reason says it out loud;
  // the reader decides whether to re-collect before acting.
  const staleYardstick = Boolean(identification?.impostor)
    && identification.reference_age_days != null
    && identification.reference_age_days >= REFERENCE_STALE_DAYS;

  // 🔴 A name, but no conviction, when the sample is thin. Resampling the cells that
  // SURVIVED cannot detect that the ones which died were the ones disagreeing with it, and
  // this project has measured that loss to be non-random: on two real runs 102 and 137 of
  // one side's 420 probes died on HTTP 429, and the cells they killed averaged S = 0.140
  // against 0.211 for the survivors. 29 cells × 15 reps needs only the first twelve cells to
  // survive to clear both the 20% valid-rate bar and the twelve-cell bar — and a ranking
  // over exactly those twelve can be perfectly stable while being an artefact of which
  // minute the quota ran out in. `rank_stability` cannot see this; only the valid rate can.
  //
  // Reported either way: the leaning still travels in `identification`, and the reason says
  // why it did not become a verdict, so a thin run reads as "re-run this", not as silence.
  const accuses = Boolean(identification?.impostor);
  // `identification` has already withheld the name; this only decides how loudly to say so.
  const withheldForThinSample = identification?.withheld === 'valid_rate';
  const withheldNote = withheldForThinSample
    ? ` ⚠️ It is worth re-running: this distribution is nonetheless shaped like ` +
      `${identification.nearest} rather than the ${refSubject.model} it was sold as ` +
      `(separation ${fmtSep(identification.separation)} over ${identification.cells} cells). ` +
      `That is reported and not convicted on, because only ` +
      `${(r.subject.valid_rate * 100).toFixed(0)}% of the subject's probes came back valid and ` +
      `probe loss on this path is not random — the cells that die are systematically the ` +
      `closer-matching ones, which is exactly the direction that manufactures this finding.`
    : '';

  const base = {
    subject: r.subject, control: r.control, live_cells: live.length,
    h: NaN, s: NaN, d: NaN, h_c: NaN, s_c: NaN, d_c: NaN,
    ratio: NaN, ratio_ci_lo: NaN, ratio_ci_hi: NaN,
    sd_ratio: NaN, sd_ci_lo: NaN, sd_ci_hi: NaN, denominator_basis: null,
    // 🔴 The gate's own low-confidence flag, not a hard false. An early return that
    // convicts on a 27% valid rate must still be labelled low confidence — the comparison
    // table and the web badge both key on this, and `false` here made a thin case look solid.
    noise_floor: NaN,
    low_confidence: gateFromValidRate(r.subject.valid_rate) === 'low_confidence',
    identification,
  };

  const sides = sampledControl ? ['subject', 'control'] : ['subject'];
  for (const side of sides) {
    const gate = applyGates({
      tier: 'l2', validRate: r[side].valid_rate,
      liveCells: live.length, requestedCells: selection.cells.length,
    });
    if (gate.verdict === VERDICT.NOT_APPLICABLE) {
      // 🔴 A named impostor outranks a control that could not be measured: the subject side
      // was strong enough to be identified, and the reason says which side failed.
      return assertL2Result(makeL2Result({
        ...base,
        verdict: accuses ? VERDICT.SUSPECT : gate.verdict,
        reason: accuses
          ? `${impostorReason(identification, refSubject.model, staleYardstick)} (the ${side} side then failed its ` +
            `gate — ${gate.reason} — so the calibrated numbers below are absent, but the ` +
            `identification never used them)`
          : `${side}: ${gate.reason}${withheldNote}`,
      }));
    }
  }
  const gate = applyGates({
    tier: 'l2',
    validRate: Math.min(...sides.map((side) => r[side].valid_rate)),
    liveCells: live.length, requestedCells: selection.cells.length,
  });
  if (gate.verdict) {
    return assertL2Result(makeL2Result({
      ...base,
      verdict: accuses ? VERDICT.SUSPECT : gate.verdict,
      reason: accuses
        ? `${impostorReason(identification, refSubject.model, staleYardstick)} (${gate.reason})`
        : `${gate.reason}${withheldNote}`,
    }));
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

  const h = meanOf(hPer);
  const s = meanOf(sPer);
  const d = meanOf(dPer);
  const [h_c, s_c, d_c] = [correct(h, floorH), correct(s, floorS), correct(d, floorD)];

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
    // ⚠️ Against the SUBJECT's floor, like `denomFloor` and for the same reason: the
    // question is "did the harness measure anything this run can resolve", not "did it
    // exceed its own scatter". Comparing H_c to H's own floor makes `0 >= 0` true, so a
    // control that never varies would be reported as having carried the denominator.
    : (h_c >= floorS ? 'harness' : 'noise floor');

  // Both intervals describe exactly the quantity their test compares — same correction,
  // same floor, one definition (see stats/bootstrap.js). `denomFloor` is where the
  // flooring actually happens; there is no second copy of it in the verdict below.
  // Each ratio corrects its numerator by S's floor and its denominator by that
  // denominator's own — same definition as the point estimates above, one place.
  // ⚠️ `correctDen` and `denomFloor` are NOT the same number and must not be set alike.
  // `correctDen` removes that denominator's own sampling bias, so it is H's floor for S/H
  // and D's for S/D. `denomFloor` is the smallest denominator we are willing to divide by —
  // "is the gap inside what THIS MEASUREMENT can resolve at all" — which is the subject's
  // floor in both cases. Setting it to H's undid the guard exactly where it earns its keep:
  // a control reference that never varies floors at 0, the denominator is then allowed to
  // be 0, and the ratio goes to Infinity. Measured: relay-C's S/H stopped being a number, and
  // two genuine endpoints fell out of CONSISTENT for the arithmetic rather than the evidence.
  // 🔴 Before the ratios, because they cannot be computed without a floor — and a floor
  // that could not be MEASURED must not be read as zero. `noiseFloor({})` returns 0 by
  // construction and a missing per-cell correction used to be filled with 0, so a reference
  // holding a fingerprint but too few samples produced "this comparison has no sampling
  // noise at all": the most confident possible statement, from the least evidence.
  // Constructed, it convicts a genuine endpoint at an S/D lower bound of 1.0.
  //
  // ⚠️ The identification branch still gets its say first — it carries its own floor and
  // refuses on its own terms, so a library too thin for S/H/D can still name a model.
  if (uncalibratable.length) {
    // 🔴 The uncalibratable quantities are reported as NaN, not as the numbers a
    // disqualified pool produced. They look like ordinary calibrated values on the CLI and
    // the page — `noise_floor_h = 0`, `d_c = 1` — and a reader has no way to tell that the
    // pool behind them was refused. The verdict does not use them, which is exactly why
    // they would go unquestioned.
    const badS = cannotCalibrate(subjPools);
    const badC = cannotCalibrate(ctlPools);
    const partial = {
      ...base, h, s, d,
      h_c: badC ? NaN : h_c,
      s_c: badS ? NaN : s_c,
      // D rests on BOTH references, whichever branch produced it.
      d_c: (badS || badC) ? NaN : d_c,
      noise_floor: badS ? NaN : floor,
      noise_floor_h: badC ? NaN : floorH,
      noise_floor_d: (badS || badC) ? NaN : floorD,
      per_cell: { h: hPer, s: sPer, d: dPer }, dropped_cells: dropped,
    };
    if (accuses) {
      return assertL2Result(makeL2Result({
        ...partial, verdict: VERDICT.SUSPECT,
        reason: impostorReason(identification, refSubject.model, staleYardstick),
      }));
    }
    return assertL2Result(makeL2Result({
      ...partial, verdict: VERDICT.INCONCLUSIVE,
      reason: `这次比较算不出噪声地板：${uncalibratable.join('、')}在参与比较的格子上`
        + `不足 ${REFERENCE_MIN_N} 个有效样本，所以「同一个模型测两次能差多远」无从得知。`
        + '把它当成 0 会让每一点差距都显得确凿——那是用最少的证据说出最有把握的话。'
        + '重采一份样本够厚的参照再判。',
    }));
  }

  // 🔴 The PER-CELL corrections, so each bootstrap draw is calibrated against the cells it
  // drew. Passing `.overall` here made every draw subtract a whole-battery mean from an
  // average over a different subset — the interval then had nothing to say about how the
  // correction itself varies, and on an uneven battery it collapsed onto the point estimate.
  const ci = ratioCI(sPer, hPer, { correctBy: floorSByCell, correctDen: floorHByCell, denomFloor: floorSByCell });
  const ciSD = ratioCI(sPer, dPer, { correctBy: floorSByCell, correctDen: floorDByCell, denomFloor: floorSByCell });

  const withNumbers = {
    ...base, h, s, d, h_c, s_c, d_c, noise_floor: floor,
    noise_floor_h: floorH, noise_floor_d: floorD,
    ratio: ci.ratio, ratio_ci_lo: ci.lo, ratio_ci_hi: ci.hi,
    sd_ratio: ciSD.ratio, sd_ci_lo: ciSD.lo, sd_ci_hi: ciSD.hi,
    denominator_basis: denominatorBasis,
    per_cell: { h: hPer, s: sPer, d: dPer }, dropped_cells: dropped,
    low_confidence: gate.lowConfidence, identification,
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
  // is not a yardstick — the relay is answering alike for both model names.
  const scaleUsable = d_c >= floor;
  // What the two models look like apart on ground truth, for the message below.
  const refD = correct(meanOf(perCellJsd(refSubject.fingerprint, refControl.fingerprint, live)), floor);

  // 🔴 Checked BEFORE any verdict, not just before `suspect`. This whole method rests on
  // one assumption — the control model is genuine on BOTH sides — and a collapsed D is
  // that assumption failing. H then measures the control being substituted too, not a
  // harness, and "the harness explains the gap" becomes a false green.
  //
  // Measured, not hypothetical: relay-B returned H_c 0.3286, S_c 0.2325, D_c 0.0791 against
  // a floor of 0.0833. Its two model names are three times closer to each other than the
  // genuine pair is (0.384 on the official API), and the run was reported CONSISTENT
  // because the enormous H swallowed the enormous S. Both models were off; nothing was
  // a harness.
  //
  // ⚠️ --no-control cannot catch this: D then comes from the references, so it is the
  // genuine pair distance by construction and never collapses.
  //
  // 🔴 Identification is checked FIRST — ahead of the collapse guard and ahead of
  // `consistent` — because it is the only route that survives either of them.
  //
  // Ahead of the collapse guard: a collapsed D says "this run cannot calibrate", which is
  // true of the H/S/D arithmetic and irrelevant to identification, which never touches the
  // control. The endpoint that produced the collapse was ALSO named, at 3.55× separation,
  // and reporting only "cannot calibrate" threw that away. The collapse is still visible
  // in the result (`d_c` under `noise_floor`) for any reader who wants it.
  //
  // Ahead of `consistent`: the two should not be able to fire together — a distribution
  // close enough to the subject reference for S/H to clear the line ought to rank that
  // reference first. `assertL2Result` refuses the combination outright, so if the
  // orderings ever disagree the run fails loudly instead of printing the calmer half.
  if (accuses) {
    return assertL2Result(makeL2Result({
      ...withNumbers, verdict: VERDICT.SUSPECT,
      reason: impostorReason(identification, refSubject.model, staleYardstick),
    }));
  }


  // 🔴 Named, but on a sample too thin to convict on — and that must not fall through to
  // `consistent`. The S/H arithmetic below reads the same surviving cells the identification
  // read, so if those cells are a biased survivor set both routes are reading the artefact;
  // one of them saying "looks fine" would be the calmest possible way to be wrong.
  if (withheldForThinSample) {
    return assertL2Result(makeL2Result({
      ...withNumbers, verdict: VERDICT.INCONCLUSIVE,
      reason: `not enough of this run came back to convict on.${withheldNote}`,
    }));
  }


  if (sampledControl && !scaleUsable) {
    return assertL2Result(makeL2Result({
      ...withNumbers, verdict: VERDICT.INCONCLUSIVE,
      reason: '⚠️ this relay answers alike for BOTH model names: the subject vs the control ' +
              `measures D_c ${d_c.toFixed(4)}, inside the noise floor (${floor.toFixed(4)}), while ` +
              `the reference endpoint puts them ${refD.toFixed(4)} apart. The control is supposed to ` +
              `be the genuine model on both sides — that is what makes H a harness measurement — so ` +
              `this run cannot calibrate anything, and a "consistent" here would only mean the two ` +
              `substitutions cancelled. Screen the control model in its own right.`,
    }));
  }

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
 * Collect both sides and judge. `live cells × 15 reps × (1 or 2 sides)` logical probes —
 * 405 for a 27-cell battery without a control, 810 with one.
 */
export async function calibrateL2({ probe, subject, control, refSubject, refControl, fpProtocol,
                                    refs, sampleControl = true, concurrency, onProgress }) {
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
    refSubject, refControl, selection, refs,
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

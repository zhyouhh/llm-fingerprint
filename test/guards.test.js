import test from 'node:test';
import assert from 'node:assert/strict';

import { usableCells, applyGates, L2_MIN_N, VERDICT } from '../src/stats/guards.js';
import { UsageError } from '../src/lib/errors.js';

const L1_CELLS = { 'a|en': 5, 'b|en': 5, 'c|en': 5 };

test('① L1 at its own calibration: three full cells survive and the run proceeds', () => {
  // 🔴 The regression this exists for: hard-coding the paper's MIN_N of 10 here drops
  // all three five-sample cells, leaves zero live cells, and L1 returns inconclusive
  // forever — with nothing in the output looking wrong.
  const { live, dropped } = usableCells(L1_CELLS, { minN: 5 });
  assert.deepEqual(live, ['a|en', 'b|en', 'c|en']);
  assert.equal(dropped.length, 0);

  const gate = applyGates({ tier: 'l1', validRate: 1, liveCells: live.length, requestedCells: 3 });
  assert.equal(gate.verdict, null, 'no gate should trip');
  assert.equal(gate.lowConfidence, false);

  // And the same cells against L2's threshold would all vanish — which is exactly why
  // the threshold cannot have a default.
  assert.equal(usableCells(L1_CELLS, { minN: L2_MIN_N }).live.length, 0);
});

test('② L1 one sample short in one cell → inconclusive, not a weaker verdict', () => {
  const { live, dropped } = usableCells({ ...L1_CELLS, 'c|en': 4 }, { minN: 5 });
  assert.deepEqual(live, ['a|en', 'b|en']);
  assert.deepEqual(dropped, [{ cell: 'c|en', n_valid: 4 }]);

  const gate = applyGates({ tier: 'l1', validRate: 1, liveCells: live.length, requestedCells: 3 });
  assert.equal(gate.verdict, VERDICT.INCONCLUSIVE);
  assert.match(gate.reason, /calibrated/);
});

test('③ L2 drops a cell that fell one short of the paper threshold', () => {
  const perCell = { 'a|en': { n_valid: 15 }, 'b|en': { n_valid: 9 }, 'c|en': { n_valid: 10 } };
  const { live, dropped } = usableCells(perCell, { minN: L2_MIN_N });
  assert.deepEqual(live, ['a|en', 'c|en']);
  assert.deepEqual(dropped, [{ cell: 'b|en', n_valid: 9 }]);
});

test('④ a 10% valid rate is not applicable at either layer', () => {
  for (const tier of ['l1', 'l2']) {
    const gate = applyGates({ tier, validRate: 0.1, liveCells: 6, requestedCells: 3 });
    assert.equal(gate.verdict, VERDICT.NOT_APPLICABLE, tier);
    assert.match(gate.reason, /below 20%/);
  }
});

test('⑤ a 50% valid rate judges normally at L2, flagged low confidence', () => {
  const gate = applyGates({ tier: 'l2', validRate: 0.5, liveCells: 6, requestedCells: 6 });
  assert.equal(gate.verdict, null, 'still judge');
  assert.equal(gate.lowConfidence, true);
});

test('🔴 L1 never carries a low-confidence flag', () => {
  // L1 demands five valid samples in every cell and drops any cell short of that, so a
  // run that reaches a verdict is necessarily at 15/15. The 20–80% band is unreachable,
  // and a flag there would be dead code implying a wounded verdict exists.
  for (const validRate of [0.25, 0.5, 0.79]) {
    const gate = applyGates({ tier: 'l1', validRate, liveCells: 3, requestedCells: 3 });
    assert.equal(gate.lowConfidence, false, `validRate=${validRate}`);
  }
  assert.equal(applyGates({ tier: 'l2', validRate: 0.5, liveCells: 3, requestedCells: 3 }).lowConfidence, true,
    'but L2 does flag it');
});

test('L2 needs at least three live cells', () => {
  assert.equal(applyGates({ tier: 'l2', validRate: 1, liveCells: 2, requestedCells: 6 }).verdict,
    VERDICT.INCONCLUSIVE);
  assert.equal(applyGates({ tier: 'l2', validRate: 1, liveCells: 3, requestedCells: 6 }).verdict, null,
    'three is enough — L2 degrades gracefully, unlike L1');
});

test('minN has no default, and the tier must be known', () => {
  assert.throws(() => usableCells(L1_CELLS), UsageError);
  assert.throws(() => usableCells(L1_CELLS, { minN: 0 }), UsageError);
  assert.throws(() => applyGates({ tier: 'l0', validRate: 1, liveCells: 3, requestedCells: 3 }), /unknown tier/);
});

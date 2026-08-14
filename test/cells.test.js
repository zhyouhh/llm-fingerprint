import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { selectCells, DEAD_CELL_SIGNAL } from '../src/probe/cells.js';
import { L1_LOGICAL_SAMPLES, l2LogicalPerSide } from '../src/contracts.js';

// 🔴 A FROZEN copy, not reference/. These tests pin exact values to lock the
// calculation pipeline — thresholds are asserted with ===, no tolerance — and
// reference/ is expected to be re-collected whenever the endpoint warrants it.
// Pointing them at the live file would mean every legitimate refresh breaks the
// regression suite, and a suite that breaks for legitimate reasons gets muted.
const load = (m) => JSON.parse(readFileSync(new URL(`./fixtures/reference/chat/genuine-${m}.json`, import.meta.url), 'utf8'));
const sol = load('gpt-5.6-sol');
const g54 = load('gpt-5.4');

test('the zero-signal cells are dropped', () => {
  // Measured, not assumed: sol and 5.4 answer num10-random identically in both
  // languages (JSD 0.000000). Spending a quarter of the budget there buys nothing —
  // which is what the previous fixed 8-cell battery did on every run.
  const l2 = selectCells(sol, g54, { tier: 'l2', trials: 100 });
  assert.deepEqual([...l2.dead].sort(), ['num10-random|en', 'num10-random|zh']);
  assert.ok(!l2.cells.some((c) => c.task_id === 'num10-random'));
});

test('L2 takes every live cell at 15 reps → 90 per side', () => {
  const l2 = selectCells(sol, g54, { tier: 'l2', trials: 100 });
  assert.equal(l2.cells.length, 6);
  assert.equal(l2.repsPerCell, 15);
  // 🔴 Derived from the selection, never a constant. It WAS a constant — `90 = 6 cells ×
  // 15 reps` — and the day the battery grew to the paper's full forty every L2 run died
  // on "435 samples exceed the declared denominator 90".
  assert.equal(l2.totalReps, l2LogicalPerSide(l2));
});

test('L1 takes the three cleanest cells at 5 reps → 15', () => {
  const l1 = selectCells(sol, g54, { tier: 'l1', trials: 100 });
  assert.equal(l1.cells.length, 3);
  assert.equal(l1.repsPerCell, 5);
  assert.equal(l1.totalReps, L1_LOGICAL_SAMPLES);

  // Ranked by signal-to-noise, not raw signal: a cell separating the models by 0.05 is
  // worthless if the same model measured twice already differs by 0.04.
  const snrs = l1.cells.map((c) => c.snr);
  assert.deepEqual([...snrs].sort((a, b) => b - a), snrs, 'chosen cells must be the top of the SNR order');
  assert.ok(l1.cells.every((c) => c.signal > DEAD_CELL_SIGNAL));
});

test('selection is deterministic', () => {
  const a = selectCells(sol, g54, { tier: 'l1', trials: 100, seed: 5 });
  const b = selectCells(sol, g54, { tier: 'l1', trials: 100, seed: 5 });
  assert.deepEqual(a.cells.map((c) => c.cell), b.cells.map((c) => c.cell));
});

test('a model compared with itself has no live cells at all', () => {
  // Every signal is 0, so every cell is dead. This is the shape acceptance scenario 3
  // (self-comparison) runs into, and it must not silently return a full battery.
  const self = selectCells(sol, sol, { tier: 'l2', trials: 50 });
  assert.equal(self.cells.length, 0);
  assert.equal(self.liveCount, 0);
  assert.equal(self.dead.length, 8);
});

test('unknown tiers are rejected rather than defaulted', () => {
  assert.throws(() => selectCells(sol, g54, { tier: 'l3' }), /unknown tier/);
});

// The matrix is what a reader will actually look at, so the thing it must never do is
// present a distance without the scale that makes it mean something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMatrix, meanJsd, classifyPair, identify, SEPARATION } from '../src/layers/model-matrix.js';

const mk = (model, answers, spread) => {
  const fingerprint = {}; const samples = [];
  for (const [cell, a] of Object.entries(answers)) {
    fingerprint[cell] = spread ? { [a]: 0.8, other: 0.2 } : { [a]: 1 };
    for (let i = 0; i < 30; i++) {
      samples.push({ cell, answer_class: 'valid', normalized: spread && i % 5 === 0 ? 'other' : a });
    }
  }
  return { model, fingerprint, samples, reps: 30 };
};
const CELLS = { 'c1|en': 'a', 'c2|en': 'b', 'c3|en': 'c' };
const other = Object.fromEntries(Object.entries(CELLS).map(([k]) => [k, 'z']));

test('the diagonal carries each model\'s own noise floor, not zero', () => {
  // 🔴 A zero diagonal would tell the reader that any positive number means "different",
  // which is false — the same model measured twice is already positive.
  const { matrix, floors } = modelMatrix([mk('det', CELLS, false), mk('noisy', CELLS, true)], { trials: 200 });
  assert.equal(matrix[0][0], floors[0]);
  assert.equal(matrix[1][1], floors[1]);
  assert.equal(floors[0], 0, 'a deterministic model has no sampling noise');
  assert.ok(floors[1] > 0, 'a scattered one does — and the two must not share one threshold');
});

test('the matrix is symmetric and identical models sit at their floor', () => {
  const { matrix } = modelMatrix([mk('a', CELLS, true), mk('a-copy', CELLS, true)], { trials: 200 });
  assert.equal(matrix[0][1], matrix[1][0]);
  assert.equal(matrix[0][1], 0, 'identical fingerprints are zero apart');
});

test('models answering differently everywhere are far apart', () => {
  const { matrix } = modelMatrix([mk('a', CELLS, false), mk('z', other, false)], { trials: 200 });
  assert.equal(matrix[0][1], 1, 'disjoint deterministic answers are maximally far');
});

test('a pair is only "indistinguishable" when it clears BOTH floors', () => {
  // One side being deterministic must not license the call: 0.05 is inside a noisy
  // model's own spread but far outside a deterministic one's.
  assert.equal(classifyPair(0.05, 0.0, 0.10), 'indistinguishable');
  assert.equal(classifyPair(0.05, 0.0, 0.0), 'distinct');
  assert.equal(classifyPair(0.15, 0.0, 0.10), 'near');
  assert.equal(classifyPair(NaN, 0.1, 0.1), 'no shared cells');
});

test('cells present on only one side are ignored, not scored as a difference', () => {
  const a = { 'c1|en': { x: 1 }, 'c2|en': { y: 1 } };
  const b = { 'c1|en': { x: 1 } };
  const r = meanJsd(a, b);
  assert.equal(r.cells, 1);
  assert.equal(r.value, 0, 'the shared cell agrees, so the pair agrees');
});

test('identification is decided by separation, not by absolute distance', () => {
  // 🔴 The regression: a real gateway sits 0.154 from the model it genuinely serves,
  // because the distance carries its harness. Judged against a noise floor that reads
  // "matches nothing" — which is how the first version labelled twelve measured rows,
  // four of them already proven genuine by L2. The runner-up ratio cancels the harness.
  const target = { 'c1|en': { a: 1 }, 'c2|en': { b: 1 } };
  const far = { 'c1|en': { z: 1 }, 'c2|en': { z: 1 } };
  // Measured sits well away from BOTH in absolute terms, but far closer to target.
  const measured = { 'c1|en': { a: 0.6, q: 0.4 }, 'c2|en': { b: 0.6, q: 0.4 } };

  const r = identify(measured, [{ model: 'target', fingerprint: target }, { model: 'far', fingerprint: far }]);
  assert.equal(r.best.model, 'target');
  assert.ok(r.best.value > 0.2, 'absolute distance is large — a floor test would reject it');
  assert.ok(r.separation >= SEPARATION);
  assert.equal(r.named, true, 'and yet it is a confident identification');
});

test('two near-equal candidates are refused a name', () => {
  // Exactly equidistant: the measured distribution sits halfway between the two.
  const a = { 'c1|en': { x: 0.45, y: 0.55 } };
  const b = { 'c1|en': { x: 0.50, y: 0.50 } };
  const measured = { 'c1|en': { x: 0.475, y: 0.525 } };
  const r = identify(measured, [{ model: 'a', fingerprint: a }, { model: 'b', fingerprint: b }]);
  assert.equal(r.named, false, 'when two references are equally close, neither is the answer');
});

test('a lone reference is never a match by default', () => {
  // "The only model we hold a reference for" is not an identification.
  const r = identify({ 'c1|en': { a: 1 } }, [{ model: 'only', fingerprint: { 'c1|en': { a: 1 } } }]);
  assert.equal(r.best.model, 'only');
  assert.equal(r.named, false);
  assert.ok(Number.isNaN(r.separation));
});

test('the winner is the closest reference, not the first one handed in', () => {
  // 🔴 Every other case here happens to list the right answer first, so dropping the sort
  // left them all green — a mutation caught that. Order the input adversarially.
  const target = { 'c1|en': { a: 1 }, 'c2|en': { b: 1 } };
  const decoy = { 'c1|en': { z: 1 }, 'c2|en': { z: 1 } };
  const measured = { 'c1|en': { a: 0.9, z: 0.1 }, 'c2|en': { b: 0.9, z: 0.1 } };

  const r = identify(measured, [{ model: 'decoy', fingerprint: decoy }, { model: 'target', fingerprint: target }]);
  assert.equal(r.best.model, 'target', 'the answer is last in the input array');
  assert.equal(r.runnerUp.model, 'decoy');
  assert.ok(r.ranked[0].value < r.ranked[1].value, 'ranked must come back ascending');
});

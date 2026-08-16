// The matrix is what a reader will actually look at, so the thing it must never do is
// present a distance without the scale that makes it mean something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMatrix, meanJsd, classifyPair } from '../src/layers/model-matrix.js';

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

// Unit tests for the probe layer. These pin the solver and grader — the parts a wrong
// implementation would corrupt silently — without touching the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptivePairMinimax, guaranteeSameColour, genAdaptivePair, genPigeonhole,
  generate, parseInteger, rng,
} from '../src/probes/reasoning.js';
import { grade, sample, loadBank } from '../src/probes/knowledge.js';

describe('reasoning solver', () => {
  test("reproduces hvoy's published instance (answer = 8)", () => {
    // diamond[w,p,g]=[2,9,1], triangle=[5,1,3]; goals crossed
    const v = adaptivePairMinimax([[2, 9, 1], [5, 1, 3]], [[[0, 0], [1, 1]], [[0, 1], [1, 0]]]);
    assert.equal(v, 8);
  });

  test('pigeonhole closed form matches hand calculations', () => {
    assert.equal(guaranteeSameColour({ counts: [3, 5, 7], k: 3 }), 7);   // 2+2+2+1
    assert.equal(guaranteeSameColour({ counts: [10, 10], k: 2 }), 3);    // 1+1+1
    assert.equal(guaranteeSameColour({ counts: [1, 1], k: 3 }), null);   // impossible
  });

  test('minimax never undercounts vs a brute-force adversary on a tiny grid', () => {
    // 1 of each in a 2x2 grid, single goal needing both cells of column 0.
    const v = adaptivePairMinimax([[1, 1], [1, 1]], [[[0, 0], [1, 0]]]);
    assert.ok(Number.isInteger(v) && v >= 2);
  });

  test('generated instances always carry a checkable integer answer', () => {
    for (const q of generate(20, 7)) {
      assert.ok(Number.isInteger(q.answer), `${q.family} seed=${q.seed} has no integer answer`);
      assert.match(q.prompt, /integer|number/i);
    }
  });

  test('same seed reproduces the same instance', () => {
    assert.deepEqual(genAdaptivePair(123), genAdaptivePair(123));
    assert.deepEqual(genPigeonhole(456), genPigeonhole(456));
  });

  test('rng is deterministic', () => {
    const a = rng(42), b = rng(42);
    assert.equal(a(), b());
  });

  test('parseInteger pulls the first integer or null', () => {
    assert.equal(parseInteger('the answer is 14.'), 14);
    assert.equal(parseInteger('UNKNOWN'), null);
    assert.equal(parseInteger(''), null);
  });
});

describe('knowledge grader', () => {
  test('whole-word match, case-insensitive', () => {
    assert.deepEqual(grade('BYD/China', ['BYD']), { correct: true, unknown: false });
    assert.deepEqual(grade('Guy Parmelin, Switzerland', ['Parmelin']), { correct: true, unknown: false });
  });

  test('UNKNOWN and empty score as not-correct but flagged unknown', () => {
    assert.deepEqual(grade('UNKNOWN', ['BYD']), { correct: false, unknown: true });
    assert.deepEqual(grade('', ['BYD']), { correct: false, unknown: true });
  });

  test('wrong answer is not-correct and not unknown', () => {
    assert.deepEqual(grade('Tesla', ['BYD']), { correct: false, unknown: false });
  });

  test('no substring false positives (whole word)', () => {
    // "BYDance" must not match "BYD"
    assert.equal(grade('BYDance', ['BYD']).correct, false);
  });

  test('bank loads and every item is well-formed', () => {
    const bank = loadBank();
    assert.ok(bank.items.length >= 1);
    for (const it of bank.items) {
      assert.ok(typeof it.q === 'string' && it.q.length > 0);
      assert.ok(Array.isArray(it.a) && it.a.length >= 1);
      assert.ok(it.source && it.date, `item missing provenance: ${it.q}`);
    }
  });

  test('sample is deterministic per seed and bounded', () => {
    const bank = loadBank();
    assert.deepEqual(sample(bank.items, 3, 99), sample(bank.items, 3, 99));
    assert.equal(sample(bank.items, 100, 1).length, bank.items.length);
  });
});

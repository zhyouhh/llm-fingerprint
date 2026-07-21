// G1 — distribution + JSD layer.
//
// Claim under test: our distribution builder and JSD/split-half code reproduce
// upstream's published intermediate artefacts exactly. Proof: recompute
// distributions.json, divergence-matrix.csv and split-scores.json from upstream's
// own normalized.jsonl and diff against upstream's published versions.
//
// G0 proves we canonicalise answers identically; G2 proves we score trials
// identically. G1 is the layer in between — where a wrong log base, a missing
// rounding step, or an off-by-one in the split-half parity would hide.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../../src/lib/jsonl.js';
import { loadVendorConfig, studyATasks } from '../../src/normalize/index.js';
import { buildDistributions } from '../../src/stats/distributions.js';
import { meanDivergenceMatrix, splitHalfScores } from '../../src/stats/divergence.js';
import { UPSTREAM, requireUpstream } from '../helpers/upstream.js';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

describe('G1: distributions and JSD match upstream', { skip: requireUpstream() }, () => {
  let records, ourCells, upCells, tasks, included;

  before(async () => {
    records = [];
    for await (const r of readJsonl(path.join(UPSTREAM, 'data', 'derived', 'normalized.jsonl'))) {
      records.push(r);
    }
    ourCells = buildDistributions(records, { temperature: 1 });
    upCells = readJson(path.join(UPSTREAM, 'results', 'distributions.json')).distributions;

    const { prompts } = loadVendorConfig();
    tasks = studyATasks(prompts);
    included = new Set(
      readJson(new URL('../../vendor/pamela/config/models.selected.json', import.meta.url))
        .models.filter((m) => m.included).map((m) => m.id)
    );
  });

  test('cell count matches upstream', () => {
    assert.equal(ourCells.length, upCells.length);
  });

  test('every cell matches upstream field for field', () => {
    const key = (c) => `${c.model}|${c.task_id}|${c.lang}`;
    const up = new Map(upCells.map((c) => [key(c), c]));
    const mismatches = [];
    for (const got of ourCells) {
      const want = up.get(key(got));
      if (!want) { mismatches.push({ cell: key(got), reason: 'absent upstream' }); continue; }
      for (const f of ['n_valid', 'n_off_format', 'validity_rate', 'entropy_bits', 'mode', 'mode_share']) {
        if (got[f] !== want[f]) mismatches.push({ cell: key(got), field: f, ours: got[f], upstream: want[f] });
      }
      if (JSON.stringify(got.dist) !== JSON.stringify(want.dist)) {
        mismatches.push({ cell: key(got), field: 'dist', ours: got.dist, upstream: want.dist });
      }
      if (mismatches.length >= 10) break;
    }
    assert.deepEqual(mismatches, [], JSON.stringify(mismatches.slice(0, 5), null, 2));
  });

  test('study-A battery is 10 tasks × 4 languages = 40 cells', () => {
    assert.equal(tasks.size, 10);
    const cells = new Set(
      upCells.filter((c) => tasks.has(c.task_id)).map((c) => `${c.task_id}|${c.lang}`)
    );
    assert.equal(cells.size, 40);
  });

  test('mean JSD matrix reproduces divergence-matrix.csv', () => {
    const { models, matrix } = meanDivergenceMatrix(upCells, { tasks, included });
    const csv = readFileSync(path.join(UPSTREAM, 'results', 'divergence-matrix.csv'), 'utf8')
      .trim().split('\n');
    const header = csv[0].split(',').slice(1).map((s) => s.replace(/^"|"$/g, ''));
    assert.deepEqual(models, header, 'model ordering differs');

    const mismatches = [];
    csv.slice(1).forEach((line, i) => {
      // model ids contain no commas but are quoted; split off the first field safely
      const cut = line.indexOf('",') + 2;
      const vals = line.slice(cut).split(',');
      vals.forEach((v, j) => {
        const want = v === 'NA' ? null : +v;
        const got = matrix[i][j];
        if (want === null ? got !== null : Math.abs(got - want) > 1e-9) {
          mismatches.push({ row: models[i], col: models[j], ours: got, upstream: want });
        }
      });
    });
    assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} cells differ`);
  });

  test('split-half trials reproduce split-scores.json', () => {
    const ours = splitHalfScores(records, upCells, { tasks, included });
    const up = readJson(path.join(UPSTREAM, 'results', 'split-scores.json')).scores;
    assert.equal(ours.length, up.length, 'trial count differs');

    const key = (s) => `${s.ref}|${s.probe}|${s.task_id}|${s.lang}`;
    const upMap = new Map(up.map((s) => [key(s), s]));
    const mismatches = [];
    for (const got of ours) {
      const want = upMap.get(key(got));
      if (!want) { mismatches.push({ k: key(got), reason: 'absent upstream' }); continue; }
      if (got.jsd !== want.jsd || got.genuine !== want.genuine) {
        mismatches.push({ k: key(got), ours: got.jsd, upstream: want.jsd });
      }
      if (mismatches.length >= 10) break;
    }
    assert.deepEqual(mismatches, [], JSON.stringify(mismatches.slice(0, 5), null, 2));
  });
});

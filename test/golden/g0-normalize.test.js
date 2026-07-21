// G0 — normalisation layer.
//
// Claim under test: our vendored/extracted normaliser canonicalises answers exactly
// like upstream's. Proof: re-normalise upstream's own raw responses and diff against
// upstream's own published normalized.jsonl, field by field, over all 335,889 records.
//
// If this fails, our fingerprints are silently incomparable with the reference
// database — every other test could still pass. Nothing downstream is trustworthy
// until this is green.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../../src/lib/jsonl.js';
import { normalizeRuns } from '../../src/normalize/index.js';
import { UPSTREAM, requireUpstream } from '../helpers/upstream.js';

// Upstream published normalized.jsonl for the confirmatory run only (main-02);
// pilots are excluded by pre-registration discipline, main-01 is ABANDONED.
const RUN = 'main-02';
const runsDir = path.join(UPSTREAM, 'data', 'runs');
const expectedPath = path.join(UPSTREAM, 'data', 'derived', 'normalized.jsonl');

describe('G0: normalisation matches upstream', { skip: requireUpstream() }, () => {
  let ours;
  let expected;

  before(async () => {
    ours = await normalizeRuns(runsDir, { runs: [RUN] });
    expected = new Map();
    for await (const rec of readJsonl(expectedPath)) expected.set(rec.key, rec);
  });

  test('record count matches exactly', () => {
    assert.equal(ours.length, expected.size,
      `we produced ${ours.length} records, upstream published ${expected.size}`);
  });

  test('every normalised field matches, record by record', () => {
    const mismatches = [];
    for (const got of ours) {
      const want = expected.get(got.key);
      if (!want) { mismatches.push({ key: got.key, reason: 'key absent upstream' }); continue; }
      for (const field of ['normalized', 'answer_class', 'color_canon']) {
        if (got[field] !== want[field]) {
          mismatches.push({
            key: got.key, field, raw: want.raw,
            task: want.task_id, lang: want.lang,
            ours: got[field], upstream: want[field],
          });
        }
      }
      if (mismatches.length >= 20) break; // enough to diagnose
    }
    assert.deepEqual(mismatches, [],
      `normalisation diverges from upstream:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`);
  });

  test('answer_class histogram matches upstream', () => {
    const hist = (recs) => {
      const h = {};
      for (const r of recs) h[r.answer_class] = (h[r.answer_class] ?? 0) + 1;
      return h;
    };
    assert.deepEqual(hist(ours), hist([...expected.values()]));
  });
});

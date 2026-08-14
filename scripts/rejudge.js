#!/usr/bin/env node
// Re-judge existing L1 result files under the CURRENT calibration. ZERO new requests.
//
// This is the 重跑边界 promise being cashed in: the file holds every raw answer, and meta
// records which reference version, which wire, which cells, how many reps and which
// thresholds produced the verdict — so a fix to the judging path can be applied to data
// already paid for. The first real use was a normalisation-mismatch bug that voided a
// whole screening round; re-judging cost nothing instead of another 60 requests.
//
// 🔴 The judging itself lives in src/layers/rejudge.js, shared with the comparison table.
// This script used to carry its own copy of the same steps, which is precisely how the
// table came to disagree with this command in the first place.
import path from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERDICT } from '../src/contracts.js';
import { rejudgeL1 } from '../src/layers/rejudge.js';
import { runMain } from '../src/lib/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'var', 'runs');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

await runMain(async () => {
  if (!existsSync(RUNS)) {
    console.log('no runs on disk yet — nothing to re-judge.');
    return;
  }
  const files = readdirSync(RUNS).filter((f) => f.includes('__l1__')).sort();
  const latest = new Map();
  for (const f of files) latest.set(f.split('__')[0], f);   // keep the newest per endpoint

  console.log('re-judging L1 runs from disk — 0 new requests\n');
  console.log('endpoint     wire        valid   S_screen    verdict');
  console.log('─'.repeat(72));

  for (const [id, file] of latest) {
    if (only.length && !only.includes(id)) continue;
    const stored = JSON.parse(readFileSync(path.join(RUNS, file), 'utf8'));

    let out;
    try {
      out = rejudgeL1(stored);
    } catch (err) {
      // A run whose reference is gone (or now lives on another wire) is reported, not
      // silently skipped — an absent row reads as "nothing to say about this endpoint".
      console.log(`${id.padEnd(12)} ${'—'.padEnd(11)} cannot re-judge: ${err.message.split('\n')[0]}`);
      continue;
    }
    const r = out.result;
    const mark = {
      [VERDICT.CONSISTENT]: '✅', [VERDICT.SUSPECT]: '🔴',
      [VERDICT.INCONCLUSIVE]: '⚠️ ', [VERDICT.NOT_APPLICABLE]: '✗ ',
    }[r.verdict];
    console.log(
      `${id.padEnd(12)} ${(out.meta.fingerprint_protocol ?? 'chat').padEnd(11)} ` +
      `${(r.valid_rate * 100).toFixed(0).padStart(3)}%   ` +
      `${(r.s_screen != null ? r.s_screen.toFixed(6) : '—').padStart(9)}   ${mark} ${r.verdict}`,
    );
    console.log(`             T_pass ${out.meta.t_pass.toFixed(6)} (${out.meta.t_pass_basis})   ` +
                `T_fail ${out.meta.t_fail.toFixed(6)}`);
    if (r.per_cell) {
      for (const [c, v] of Object.entries(r.per_cell)) console.log(`             ${c.padEnd(22)} ${v.toFixed(6)}`);
    }
    if (r.reason) console.log(`             ${r.reason}`);
  }
});

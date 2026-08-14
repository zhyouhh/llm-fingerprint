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
import { rejudgeL1, rejudgeL2 } from '../src/layers/rejudge.js';
import { runMain } from '../src/lib/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'var', 'runs');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

await runMain(async () => {
  if (!existsSync(RUNS)) {
    console.log('no runs on disk yet — nothing to re-judge.');
    return;
  }
  const mark = (v) => ({
    [VERDICT.CONSISTENT]: '✅', [VERDICT.SUSPECT]: '🔴',
    [VERDICT.INCONCLUSIVE]: '⚠️ ', [VERDICT.NOT_APPLICABLE]: '✗ ',
  }[v] ?? '? ');

  // 🔴 L2 is re-judged too. It had no re-judging path at all, so 180 already-paid-for
  // probes per endpoint stayed frozen at whatever the verdict logic said on the day.
  for (const tier of ['l1', 'l2']) {
    // 🔴 Keyed by endpoint AND wire. Keyed by endpoint alone, a Responses run silently
    // hid the chat run of the same endpoint — and those two are not versions of one
    // measurement, they are different measurements that must both stay visible.
    const latest = new Map();
    for (const f of readdirSync(RUNS).filter((x) => x.includes(`__${tier}__`)).sort()) {
      let wire = 'chat';
      try { wire = JSON.parse(readFileSync(path.join(RUNS, f), 'utf8')).meta?.fingerprint_protocol ?? 'chat'; } catch { /* keep default */ }
      latest.set(`${f.split('__')[0]}\u0000${wire}`, f);
    }
    if (latest.size === 0) continue;

    console.log(`\n${tier.toUpperCase()} — re-judged from disk, 0 new requests\n`);
    console.log(tier === 'l1'
      ? 'endpoint     wire        valid   S_screen    verdict'
      : 'endpoint     wire         H_c      S_c      D_c    S/H  90% CI          verdict');
    console.log('─'.repeat(tier === 'l1' ? 72 : 82));

    for (const [key, file] of latest) {
      const id = key.split('\u0000')[0];
      if (only.length && !only.includes(id)) continue;
      const stored = JSON.parse(readFileSync(path.join(RUNS, file), 'utf8'));

      let out;
      try {
        out = tier === 'l1' ? rejudgeL1(stored) : rejudgeL2(stored);
      } catch (err) {
        // A run whose reference is gone (or now lives on another wire) is reported, not
        // silently skipped — an absent row reads as "nothing to say about this endpoint".
        console.log(`${id.padEnd(12)} ${'—'.padEnd(11)} cannot re-judge: ${err.message.split('\n')[0]}`);
        continue;
      }
      const r = out.result;
      const wire = (out.meta.fingerprint_protocol ?? 'chat').padEnd(11);
      const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : '—').padStart(7);

      if (tier === 'l1') {
        console.log(`${id.padEnd(12)} ${wire} ${(r.valid_rate * 100).toFixed(0).padStart(3)}%   ` +
                    `${(r.s_screen != null ? r.s_screen.toFixed(6) : '—').padStart(9)}   ${mark(r.verdict)} ${r.verdict}`);
        console.log(`             T_pass ${out.meta.t_pass.toFixed(6)} (${out.meta.t_pass_basis})   ` +
                    `T_fail ${out.meta.t_fail.toFixed(6)}`);
      } else {
        const ci = Number.isFinite(r.ratio_ci_lo) ? `[${r.ratio_ci_lo.toFixed(2)}, ${r.ratio_ci_hi.toFixed(2)}]` : '—';
        console.log(`${id.padEnd(12)} ${wire}${f4(r.h_c)}  ${f4(r.s_c)}  ${f4(r.d_c)}  ` +
                    `${(Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : '—').padStart(5)}  ${ci.padEnd(15)} ${mark(r.verdict)} ${r.verdict}`);
        console.log(`             S/D ${(Number.isFinite(r.sd_ratio) ? r.sd_ratio.toFixed(2) : '—')} ` +
                    `[${Number.isFinite(r.sd_ci_lo) ? r.sd_ci_lo.toFixed(2) : '—'}, ` +
                    `${Number.isFinite(r.sd_ci_hi) ? r.sd_ci_hi.toFixed(2) : '—'}]   ` +
                    `denominator: ${r.denominator_basis}   floor ${r.noise_floor?.toFixed(4) ?? '—'}`);
      }
      if (tier === 'l1' && r.per_cell) {
        for (const [c, v] of Object.entries(r.per_cell)) console.log(`             ${c.padEnd(22)} ${v.toFixed(6)}`);
      }
      if (r.reason) console.log(`             ${r.reason}`);
    }
  }
});

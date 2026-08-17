#!/usr/bin/env node
// Place every stored measurement on the model map. ZERO requests.
//
//   node scripts/identify.js [--fp-protocol responses] [--endpoint id,id]
//
// The verdict layers answer "is this the model it claims"; this answers "then what IS it".
// The difference is worth having: telling a vendor "your gpt-5.6-sol is 0.23 from the real
// one" invites an argument, and telling them "it is gpt-5.6-luna, which you also sell"
// does not.
//
// 🔴 It can only name models we hold a reference for. A distribution that matches nothing
// says exactly that — never "closest is X" dressed up as an identification.
import path from 'node:path';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, runMain } from '../src/lib/cli.js';
import { L2_MIN_N } from '../src/stats/guards.js';
import { identification, SEPARATION, MIN_ID_CELLS, RANKING_STABILITY } from '../src/layers/model-matrix.js';
import { loadAllReferences, DEFAULT_REFERENCE_ROOT, PROTOCOL_IDS, DEFAULT_PROTOCOL } from '../src/lib/reference-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'var', 'runs');
const args = parseArgs();

const USAGE = `node scripts/identify.js [--fp-protocol P] [--endpoint a,b]

  --fp-protocol P  chat | responses（默认 responses）
  --endpoint a,b   只看这些端点

0 请求。把 var/runs/ 里每次 L2 采到的分布，对所有已有参照量距离，报最近的那个。`;

const protocol = args['fp-protocol'] === true ? 'responses' : (args['fp-protocol'] ?? 'responses');
if (!PROTOCOL_IDS.includes(protocol)) {
  console.error(`--fp-protocol takes ${PROTOCOL_IDS.join(' | ')}, got ${protocol}`);
  process.exit(2);
}
const only = typeof args.endpoint === 'string' ? args.endpoint.split(',').map((s) => s.trim()) : null;

/** ∞ is only ever +Infinity; NaN means "there was no runner-up to separate from". */
const fmtSep = (sep) => (Number.isFinite(sep) ? `${sep.toFixed(2)}×` : (Number.isNaN(sep) ? 'n/a' : '∞×'));

/**
 * Empirical per-cell distribution for one model out of a stored run.
 *
 * 🔴 Cells under `minN` are DROPPED, the same bar evaluateL2 applies. A cell with three
 * samples estimates nothing, and letting it in here is how this command could name a model
 * on evidence the verdict layer had already refused.
 */
function distributionOf(file, model, minN = L2_MIN_N) {
  const counts = {};
  for (const s of file.samples) {
    if (s.model !== model || s.state !== 'valid' || s.normalized == null) continue;
    const cell = `${s.task_id}|${s.lang}`;
    (counts[cell] ??= {})[s.normalized] = ((counts[cell] ?? {})[s.normalized] ?? 0) + 1;
  }
  const out = {};
  // 🔴 Per cell, because the floor has to describe the measurement each cell actually got.
  const reps = {};
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    if (n < minN) continue;
    out[cell] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n]));
    reps[cell] = n;
  }
  return { dist: out, reps };
}

/**
 * The valid rate as MEASURED, off the result file.
 *
 * ⚠️ Not recomputed from `file.samples`. Its denominator is the planned logical sample count
 * — `rates()` in contracts.js refuses to derive it, because failures that never reached the
 * array would drop out of the denominator and a truncated record would read as 100% valid.
 * That is the difference between withholding a name and printing 「冒名」 on an honest relay.
 * Null when the file does not say: unknown, therefore no name.
 */
function measuredValidRate(file, model) {
  const side = file.meta?.model === model ? 'subject'
    : file.meta?.control === model ? 'control'
      : null;
  const rate = side ? file.result?.[side]?.valid_rate : null;
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
}

await runMain(async () => {
  const dir = path.join(DEFAULT_REFERENCE_ROOT, protocol);
  if (!existsSync(dir) || !existsSync(RUNS)) {
    console.error('need both reference/ and var/runs/ populated.');
    process.exit(2);
  }
  // 🔴 Through loadAllReferences, never a bare readdir + JSON.parse. That bypass kept its
  // own copy of the dated-snapshot pattern AND skipped loadReference's protocol and
  // model-name checks — so a chat reference misfiled under responses/ would be refused by
  // verify-relay and still print a red 冒名 here.
  const refs = loadAllReferences(protocol);
  const models = refs.map((r) => r.model);

  console.log(`\n对 ${models.length} 份 ${protocol} 参照指认（0 请求）\n`);
  console.log('端点/卖的型号'.padEnd(40) + '最近的参照'.padEnd(20) + '距离'.padStart(8) + '  次近'.padEnd(22) + '分离度'.padStart(7) + '  判定');
  console.log('─'.repeat(112));

  // 🔴 "Newest run per endpoint+model" is decided BEFORE any of the reasons a row might be
  // skipped, and never with a `seen` set threaded through the printing loop. It was the
  // latter, with the `add` after a `continue`, so a newest run that could not be compared
  // silently yielded its slot to an OLDER one — which then printed as the current state of
  // that endpoint. Selecting first makes that ordering bug unavailable rather than fixed.
  const files = readdirSync(RUNS).filter((f) => f.includes('__l2__')).sort().reverse();
  const newest = new Map();
  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(RUNS, f), 'utf8'));
    if ((j.meta?.fingerprint_protocol ?? DEFAULT_PROTOCOL) !== protocol) continue;
    const id = f.split('__')[0];
    if (only && !only.includes(id)) continue;
    for (const sold of [j.meta.model, j.meta.control]) {
      if (!sold || (j.meta.sampled_control === false && sold === j.meta.control)) continue;
      const key = `${id}|${sold}`;
      if (!newest.has(key)) newest.set(key, { id, sold, run: j });
    }
  }

  {
    for (const { id, sold, run: j } of newest.values()) {
      const { dist: measured, reps } = distributionOf(j, sold);
      const validRate = measuredValidRate(j, sold);
      if (!Object.keys(measured).length) {
        console.log(`${id}/${sold}`.padEnd(40) + '—'.padEnd(20) + '—'.padStart(8)
          + '  —'.padEnd(22) + '—'.padStart(8)
          + '  比不了（没有一个格子攒够 10 个有效样本）');
        continue;
      }

      // 🔴 The SAME decision function evaluateL2 uses, floor and cell bar included. This
      // command used to call raw identify() and print 「冒名」 on evidence the verdict layer
      // would have refused — six cells, or a distance of zero against a near-duplicate.
      if (!models.includes(sold)) continue;
      const r = identification(measured, refs, sold, { reps, validRate });
      // 🔴 A row, not a `continue`. "Nothing in the library lines up with these cells" is a
      // finding about the LIBRARY; skipping it silently made the endpoint disappear from
      // the table entirely, which reads as "never measured" rather than "cannot compare".
      if (!r || !r.nearest) {
        console.log(`${id}/${sold}`.padEnd(40) + '—'.padEnd(20) + '—'.padStart(8)
          + '  —'.padEnd(22) + '—'.padStart(8)
          + `  比不了（${Object.keys(measured).length} 个够格的格子，但没有哪个是所有候选都答过的）`);
        continue;
      }
      const { nearest, distance, runner_up: runnerUp, runner_up_distance: runnerUpD, separation: sep } = r;
      // Which bar held it back, in the words of the bar itself. Saying "the interval lower
      // bound" for a run refused on ranking stability describes a rule that does not run.
      const why = {
        cells: `只有 ${r.cells} 格，指认要 ${MIN_ID_CELLS}`,
        floor: '参照没带样本，算不出这次比较的分辨极限',
        valid_rate: `只有 ${validRate == null ? '?' : (validRate * 100).toFixed(0)}% 的探针有效，丢格不随机`,
        separation: `与次近只差 ${fmtSep(r.separation)}，要 ${SEPARATION}×`,
        stability: `重抽格子时只有 ${(r.rank_stability * 100).toFixed(0)}% 的次数还是它，要 ${(RANKING_STABILITY * 100).toFixed(0)}%`,
        refuted: `${r.refuted_by.map((c) => c.model).join('/')} 覆盖不足但更近`,
      }[r.withheld] ?? '证据不足';
      const label = r.model
        ? (r.impostor ? `= ${r.model} 🔴 冒名` : `= ${r.model} ✅`)
        : `不确定（${why}）`;
      console.log(`${id}/${sold}`.padEnd(40) + nearest.padEnd(20) + distance.toFixed(4).padStart(8)
        + `  ${runnerUp ? `${runnerUp} ${runnerUpD.toFixed(3)}` : '—'}`.padEnd(22)
        + fmtSep(sep).padStart(8) + '  ' + label);
    }
  }
  console.log(`\n判据（五道，缺一不可）：次近参照要比最近的远 ${SEPARATION}×；重抽格子时那个名字要在`
    + ` ${(RANKING_STABILITY * 100).toFixed(0)}% 的次数里仍排第一；至少 ${MIN_ID_CELLS} 个格子；`
    + `\n待验侧有效率要够（丢格不随机，幸存格能稳定指向一个错的型号）；`
    + '\n没有哪个覆盖不足的候选在共有格上更近。前提：参照库带够样本，算得出分辨极限。'
    + '\n区间下界只是参考，不参与定罪——每次重抽都会重排，所以它描述的那一对本身也在变。'
    + '\n**分离度**只是「削弱」外壳、不是消掉：等量的加性外壳把比值推向 1（更难命名，方向安全），'
    + '\n但随模型/格子而异的外壳能直接改变排名，这一层看不出来。绝对距离更不抗——'
    + '\n自建网关离它真正在发的模型也有 0.154。');
  console.log('🔴 只认得出手上有参照的型号。"不确定" ≠ "是最近的那个"。'
    + '\n   补候选：node scripts/refresh-reference.js --endpoint official --model <m> --cells full --fp-protocol responses');
});

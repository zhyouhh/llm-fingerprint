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
import { identify, SEPARATION } from '../src/layers/model-matrix.js';
import { referencePath, DEFAULT_REFERENCE_ROOT, PROTOCOL_IDS, DEFAULT_PROTOCOL } from '../src/lib/reference-store.js';

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

/** Empirical per-cell distribution for one model out of a stored run. */
function distributionOf(file, model) {
  const counts = {};
  for (const s of file.samples) {
    if (s.model !== model || s.state !== 'valid' || s.normalized == null) continue;
    const cell = `${s.task_id}|${s.lang}`;
    (counts[cell] ??= {})[s.normalized] = ((counts[cell] ?? {})[s.normalized] ?? 0) + 1;
  }
  const out = {};
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    out[cell] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n]));
  }
  return out;
}

await runMain(async () => {
  const dir = path.join(DEFAULT_REFERENCE_ROOT, protocol);
  if (!existsSync(dir) || !existsSync(RUNS)) {
    console.error('need both reference/ and var/runs/ populated.');
    process.exit(2);
  }
  const models = readdirSync(dir)
    .filter((f) => /^genuine-.+\.json$/.test(f) && !/\.\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f))
    .map((f) => f.replace(/^genuine-|\.json$/g, '')).sort();
  const refs = models.map((m) => JSON.parse(readFileSync(referencePath(m, protocol), 'utf8')));

  console.log(`\n对 ${models.length} 份 ${protocol} 参照指认（0 请求）\n`);
  console.log('端点/卖的型号'.padEnd(40) + '最近的参照'.padEnd(20) + '距离'.padStart(8) + '  次近'.padEnd(22) + '分离度'.padStart(7) + '  判定');
  console.log('─'.repeat(112));

  const files = readdirSync(RUNS).filter((f) => f.includes('__l2__')).sort();
  const seen = new Set();
  for (const f of files.reverse()) {                     // newest first
    const j = JSON.parse(readFileSync(path.join(RUNS, f), 'utf8'));
    if ((j.meta?.fingerprint_protocol ?? DEFAULT_PROTOCOL) !== protocol) continue;
    const id = f.split('__')[0];
    if (only && !only.includes(id)) continue;

    for (const sold of [j.meta.model, j.meta.control]) {
      if (!sold || (j.meta.sampled_control === false && sold === j.meta.control)) continue;
      const key = `${id}|${sold}`;
      if (seen.has(key)) continue;                       // newest run per endpoint+model
      const measured = distributionOf(j, sold);
      if (!Object.keys(measured).length) continue;
      seen.add(key);

      const { best, runnerUp, separation: sep, named } = identify(measured,
        refs.map((r, i) => ({ model: models[i], fingerprint: r.fingerprint })));
      if (!best) continue;
      const label = named
        ? (best.model === sold ? `= ${best.model} ✅` : `= ${best.model} 🔴 冒名`)
        : `不确定（与次近只差 ${sep.toFixed(2)}×）`;
      console.log(`${id}/${sold}`.padEnd(40) + best.model.padEnd(20) + best.value.toFixed(4).padStart(8)
        + `  ${runnerUp ? `${runnerUp.model} ${runnerUp.value.toFixed(3)}` : '—'}`.padEnd(22)
        + `${Number.isFinite(sep) ? sep.toFixed(2) : '—'}×`.padStart(7) + '  ' + label);
    }
  }
  console.log(`\n判据：次近参照要比最近的远 ${SEPARATION}× 才敢命名。**分离度**是抗外壳的——`
    + '外壳把所有候选等量推远，做比值时抵消；\n绝对距离不抗，自建网关离它真正在发的模型也有 0.154。');
  console.log('🔴 只认得出手上有参照的型号。"不确定" ≠ "是最近的那个"。'
    + '\n   补候选：node scripts/refresh-reference.js --endpoint official --model <m> --cells full --fp-protocol responses');
});

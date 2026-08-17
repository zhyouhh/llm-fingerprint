#!/usr/bin/env node
// Pairwise distance heat map over every genuine reference on one wire. ZERO requests.
//
//   node scripts/model-matrix.js [--fp-protocol responses] [--json]
//
// This is the identification layer's map: it shows which models this project can actually
// tell apart, and by how much. A relay's measured distribution can then be placed on it —
// whichever model it lands on top of is what the relay is serving.
import path from 'node:path';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, runMain } from '../src/lib/cli.js';
import { modelMatrix, classifyPair } from '../src/layers/model-matrix.js';
import { referencePath, DEFAULT_REFERENCE_ROOT, PROTOCOL_IDS } from '../src/lib/reference-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/model-matrix.js [--fp-protocol P] [--json <file>]

  --fp-protocol P  chat | responses（默认 responses）
  --json <file>    同时写出 JSON，供 UI 用

0 请求。对角线是各模型**自己的噪声地板**——某格 ≤ 该行对角线 = 两个模型分不出来。`;

const protocol = args['fp-protocol'] === true ? 'responses' : (args['fp-protocol'] ?? 'responses');
if (!PROTOCOL_IDS.includes(protocol)) {
  console.error(`--fp-protocol takes ${PROTOCOL_IDS.join(' | ')}, got ${protocol}`);
  process.exit(2);
}

await runMain(async () => {
  const dir = path.join(DEFAULT_REFERENCE_ROOT, protocol);
  if (!existsSync(dir)) {
    console.error(`no references collected on the ${protocol} wire yet (${path.relative(ROOT, dir)} does not exist)`);
    process.exit(2);
  }
  // `genuine-<model>.json` only — the dated files beside them are backups of earlier
  // collections of the SAME model, and including them would put a model next to its own
  // past self and read as two models.
  const models = readdirSync(dir)
    .filter((f) => /^genuine-.+\.json$/.test(f) && !/\.\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f))
    .map((f) => f.replace(/^genuine-|\.json$/g, ''))
    .sort();
  if (models.length < 2) {
    console.error(`only ${models.length} reference on this wire — a matrix needs at least two.`);
    process.exit(2);
  }

  const refs = models.map((m) => {
    const j = JSON.parse(readFileSync(referencePath(m, protocol), 'utf8'));
    return { model: m, fingerprint: j.fingerprint, samples: j.samples, reps: j.reps ?? 30, collected: j.collected_utc };
  });
  const m = modelMatrix(refs);
  const { matrix, floors, pairFloors, cells } = m;

  const w = Math.max(...models.map((m) => m.length)) + 1;
  console.log(`\n${protocol} 线，${models.length} 个模型，${Math.min(...cells.flat().filter(Boolean))}–${Math.max(...cells.flat())} 个共同格\n`);
  console.log(' '.repeat(w) + models.map((m, i) => String(i).padStart(6)).join(''));
  matrix.forEach((row, i) => {
    console.log(models[i].padEnd(w) + row.map((v, j) => {
      const s = Number.isFinite(v) ? v.toFixed(3) : '  —';
      return (i === j ? `[${s}]` : ` ${s}`).padStart(6);
    }).join('') + `   ${i}`);
  });

  console.log('\n对角线 = 该模型自己的噪声地板（同一模型采两次的距离），供参考。');
  // 🔴 Not "compare against the two diagonals". Each diagonal is a mean over that model's
  // whole battery; the cell is a mean over the pair's intersection. When two references
  // cover different cells those are different measurements, and following the old
  // instruction by hand reproduces the misclassification the code no longer makes.
  console.log('判定用的是每一对自己的地板（只在它们共有的格子上量），见下面的清单——');
  console.log('≤ 该对地板 → 分不出来；≤ 两倍 → 接近；更大 → 不同模型。\n');

  // The pairs a substitution would actually hide behind: closest first.
  const pairs = [];
  for (let i = 0; i < models.length; i += 1) {
    for (let j = i + 1; j < models.length; j += 1) {
      pairs.push({ a: models[i], b: models[j], d: matrix[i][j], bar: pairFloors[i][j], verdict: classifyPair(matrix[i][j], pairFloors[i][j]) });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  console.log('最容易混淆的 8 对（掺假最可能藏在这里）:');
  for (const p of pairs.slice(0, 8)) {
    console.log(`  ${p.d.toFixed(4)}  ${p.a} ↔ ${p.b}   ${p.verdict}`);
  }

  const blind = pairs.filter((p) => p.verdict === 'indistinguishable');
  if (blind.length) {
    console.log(`\n🔴 ${blind.length} 对在本方法下分不出来 —— 这些替换检不出:`);
    for (const p of blind) console.log(`     ${p.a} ↔ ${p.b}`);
  } else {
    console.log('\n✅ 没有任何一对落在噪声地板以内 —— 这些模型两两可分。');
  }

  if (args.json) {
    const out = typeof args.json === 'string' ? args.json : 'var/model-matrix.json';
    writeFileSync(path.resolve(ROOT, out), `${JSON.stringify({
      fingerprint_protocol: protocol,
      // 🔴 Spread, not a field list. Listing them by name is how `live` was left out the
      // moment it was added — and a consumer feeding this export to `pickControl` then sees
      // zero discriminating cells for every candidate and refuses the whole library. Same
      // lesson as `makeL2Result` dropping `reason`: a builder that enumerates what it keeps
      // silently discards whatever it has not been told about yet.
      ...m,
      collected: refs.map((r) => r.collected), pairs,
    }, null, 2)}\n`);
    console.log(`\n  saved ${out}`);
  }
});

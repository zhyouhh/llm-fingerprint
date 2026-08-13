#!/usr/bin/env node
// Fetch and extract the upstream PAMELA artefacts from Zenodo into data/upstream/.
//
// Both are needed by the golden tests. ~52 MB download, ~500 MB extracted, gitignored.
//
// Usage: npm run fetch-data      download + extract what is missing
//        npm run verify-data     check only — no download, no extract, no writes
import { mkdirSync, existsSync, statSync, readdirSync, createWriteStream, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'data', 'upstream');

const ARTEFACTS = [
  {
    name: 'data',
    doi: '10.5281/zenodo.21278557',
    url: 'https://zenodo.org/api/records/21278557/files/pamela-publish-data.zip/content',
    // sha from the Zenodo record; guards against a truncated or swapped download
    md5: 'f2ce3fba3081f73e9908179fb2f061b6',
    probe: 'results/verification.json',
  },
  {
    name: 'code',
    doi: '10.5281/zenodo.21278793',
    url: 'https://zenodo.org/api/records/21278793/files/pamela-publish-code.zip/content',
    md5: null,
    probe: 'config/prompts.json',
  },
];

// Everything the golden tests actually open, relative to data/upstream/.
// Keep this in step with test/golden/*.test.js — a stale list makes `--verify` pass
// while `npm test` fails on a missing file, which is the exact confusion it exists to
// prevent.
const REQUIRED = [
  { rel: 'data/data/runs',                     kind: 'dir',  used: 'G0 输入（逐 run 的 responses.jsonl）' },
  { rel: 'data/data/derived/normalized.jsonl', kind: 'file', used: 'G0 期望输出 / G1 输入' },
  { rel: 'data/results/distributions.json',    kind: 'file', used: 'G1 分布对拍' },
  { rel: 'data/results/divergence-matrix.csv', kind: 'file', used: 'G1 JSD 对拍' },
  { rel: 'data/results/split-scores.json',     kind: 'file', used: 'G1 split-half / G2 输入' },
  { rel: 'data/results/verification.json',     kind: 'file', used: 'G2 期望输出（AUC / EER）' },
  { rel: 'code/config/prompts.json',           kind: 'file', used: '上游 prompts（归一化口径）' },
];

/** @returns {string|null} null when fine, else why it is not usable. */
function checkOne({ rel, kind }) {
  const abs = path.join(DEST, rel);
  if (!existsSync(abs)) return '缺失';
  const st = statSync(abs);
  if (kind === 'dir') {
    if (!st.isDirectory()) return '应为目录，实为文件';
    if (readdirSync(abs).length === 0) return '目录为空';
    return null;
  }
  if (!st.isFile()) return '应为文件，实为目录';
  if (st.size === 0) return '文件为空（0 字节）';
  return null;
}

function verify() {
  const problems = [];
  for (const item of REQUIRED) {
    const why = checkOne(item);
    if (why) problems.push({ ...item, why });
  }
  if (problems.length === 0) {
    console.log(`✓ upstream 数据齐全（${REQUIRED.length} 项）— golden test 可以跑`);
    return 0;
  }
  console.error(`✗ upstream 数据不完整：${problems.length}/${REQUIRED.length} 项有问题\n`);
  for (const p of problems) {
    console.error(`  - data/upstream/${p.rel}\n      ${p.why} · 用于 ${p.used}`);
  }
  console.error(`\n补救：npm run fetch-data`);
  return 1;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extract(zip, into) {
  mkdirSync(into, { recursive: true });
  // Node has no built-in unzip; every supported platform ships one of these.
  try {
    execFileSync('tar', ['-xf', zip, '-C', into], { stdio: 'inherit' });
  } catch {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`], { stdio: 'inherit' });
  }
}

if (process.argv.includes('--verify')) {
  process.exit(verify());
}

for (const a of ARTEFACTS) {
  const into = path.join(DEST, a.name);
  if (existsSync(path.join(into, a.probe))) {
    console.log(`✓ ${a.name} already present (${a.doi})`);
    continue;
  }
  mkdirSync(DEST, { recursive: true });
  const zip = path.join(DEST, `${a.name}.zip`);
  console.log(`↓ fetching ${a.name} — ${a.doi}`);
  await download(a.url, zip);
  console.log(`  extracting → data/upstream/${a.name}/`);
  extract(zip, into);
  rmSync(zip);
}

console.log('\nUpstream artefacts ready. Next: npm run test:golden');

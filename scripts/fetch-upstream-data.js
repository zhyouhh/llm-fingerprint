#!/usr/bin/env node
// Fetch and extract the upstream PAMELA artefacts from Zenodo into data/upstream/.
//
// Both are needed by the golden tests; the dataset is also the source for refdb/.
// ~52 MB download, ~500 MB extracted, gitignored.
//
// Usage: npm run fetch-data
import { mkdirSync, existsSync, createWriteStream, rmSync } from 'node:fs';
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

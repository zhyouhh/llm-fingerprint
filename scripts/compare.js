#!/usr/bin/env node
// Cross-endpoint comparison — the milestone-1 deliverable.
//
//   npm run compare -- [--tier screen|full] [--only a,b] [--sort <column>] [--from-disk]
//
// Reads whatever each endpoint has already produced under var/runs/ and folds it into
// one row per endpoint. With --tier it also collects what is missing first.
//
// 决策 #14 — separate columns, no weighted total. Weights would have to come from the
// person reading the table, so the sort key is switchable instead.
import path from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, runMain } from '../src/lib/cli.js';
import { listWithKeys } from '../src/lib/config.js';
import { buildRow, sortRows, renderTable, COLUMNS } from '../src/layers/compare-table.js';
import { rejudgeL1 } from '../src/layers/rejudge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'var', 'runs');
const args = parseArgs();

if (args.help || args.h) {
  console.log(`npm run compare -- [--only a,b] [--sort <column>]

  --only a,b       只看这几个端点
  --sort <column>  换排序键（默认 authenticity）；可用: ${COLUMNS.join(', ')}

读 var/runs/ 下已有的结果，不发新请求。采集用 profile.js / screen.js / verify-relay.js。`);
  process.exit(0);
}

/** Newest result file of a given tier for an endpoint. */
function latest(endpointId, tier) {
  if (!existsSync(RUNS)) return null;
  const f = readdirSync(RUNS).filter((x) => x.startsWith(`${endpointId}__${tier}__`)).sort().pop();
  return f ? JSON.parse(readFileSync(path.join(RUNS, f), 'utf8')) : null;
}

await runMain(async () => {
  const only = typeof args.only === 'string' ? args.only.split(',').map((s) => s.trim()) : null;
  const rows = [];

  const all = listWithKeys();
  // The endpoint whose genuineness is established outside this tool; its live screens
  // are what widen T_pass (see combineThresholds).
  const genuineEndpointId = all.find((e) => e.endpoint.genuine)?.endpoint.id ?? null;

  for (const { endpoint, skipped, reason } of all) {
    if (only && !only.includes(endpoint.id)) continue;
    // A missing key skips the row and the run continues — one unconfigured candidate
    // must not take the whole comparison down.
    if (skipped) { rows.push(buildRow({ endpointId: endpoint.id, skipped: true, reason })); continue; }
    rows.push(buildRow({
      endpointId: endpoint.id,
      l0: latest(endpoint.id, 'l0'),
      // 🔴 Re-judged, never read verbatim: a stored verdict was reached under whatever
      // calibration was current that day, and reporting it back would surface
      // conclusions this project no longer holds.
      l1: (() => { const f = latest(endpoint.id, 'l1'); return f ? rejudgeL1(f, { genuineEndpointId }) : null; })(),
      l2: latest(endpoint.id, 'l2'),
      reasoning: latest(endpoint.id, 'reasoning'),
    }));
  }

  const sortBy = typeof args.sort === 'string' ? args.sort : 'authenticity';
  if (!COLUMNS.includes(sortBy)) {
    console.error(`unknown --sort column ${JSON.stringify(sortBy)}; available: ${COLUMNS.join(', ')}`);
    process.exit(2);
  }

  console.log(renderTable(sortRows(rows, sortBy)));
  console.log(`\n  sorted by ${sortBy}. † = low confidence (valid rate 20–80%).`);
  console.log('  (l2) = calibrated, harness effect removed — the only layer that separates');
  console.log('        "wrapped differently" from "not the same model".');
  console.log('  (l1) = screen only: an L1 distance still contains the harness difference.');
  console.log('  probes/attempts = summed across every layer this endpoint actually ran.');
});

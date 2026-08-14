#!/usr/bin/env node
// Re-collect a genuine reference, cell by cell.
//
//   node scripts/refresh-reference.js --endpoint <id> --model M [--cells l1|all] [--reps 30]
//
// A reference is this project's ground truth, and it has a shelf life: the endpoint it
// was collected from is itself a moving target. 24 days after the first collection the
// same gateway answered num100-random|zh with 57/73/57/57/47 where the stored reference
// says 47 with probability 1 — and the screen duly reported the project's own genuine
// endpoint as suspect. Refreshing is normal maintenance, not an emergency.
//
// 🔴 The file records the normalisation setting it was collected under. Comparing two
// sides normalised differently silently voids the comparison, and the only reason that
// bug was findable at all is that someone went and read the raw samples.
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg, runMain } from '../src/lib/cli.js';
import { fingerprintProbeFactory, FINGERPRINT_PROTOCOLS } from '../src/probe/http/fingerprint-probe.js';
import { runBattery, QUICK_CELLS } from '../src/probe/runner.js';
import { rates } from '../src/contracts.js';
import { selectCells } from '../src/probe/cells.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/refresh-reference.js --endpoint <id> --model M [--cells l1|all] [--reps 30]

  --endpoint <id>  已知正版端点的 id —— 参照只能从正版采
  --model M        模型（默认取该端点的 models.subject）
  --cells l1       只重采 L1 用的三格（90 次，最省）
  --cells all      重采全部 8 格（240 次）
  --reps N         每格次数（默认 30，与既有参照同口径）
  --fp-protocol P  指纹层协议: chat（默认，论文口径）| responses（官方 API 唯一可行的）

⚠️ 两种协议的分布不同，参照与待测必须用同一种。文件会记下它，比较时会校验。`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
const model = args.model ?? endpoint.models.subject;
const reps = Number(args.reps ?? 30);
const which = args.cells === true ? 'l1' : (args.cells ?? 'l1');
const fpProtocol = args['fp-protocol'] === true ? 'chat' : (args['fp-protocol'] ?? 'chat');
if (!FINGERPRINT_PROTOCOLS[fpProtocol]) {
  console.error(`--fp-protocol takes chat or responses, got ${fpProtocol}`);
  process.exit(2);
}

await runMain(async () => {
  const refPath = path.join(ROOT, 'reference', `genuine-${model}.json`);
  const existing = existsSync(refPath) ? JSON.parse(readFileSync(refPath, 'utf8')) : null;

  let cells;
  if (which === 'all') {
    cells = QUICK_CELLS.map(([task_id, lang]) => ({ task_id, lang, reps }));
  } else {
    const control = endpoint.models.control;
    const controlRef = JSON.parse(readFileSync(path.join(ROOT, 'reference', `genuine-${control}.json`), 'utf8'));
    // The same three cells L1 will actually screen on — no point paying for the rest.
    cells = selectCells(existing, controlRef, { tier: 'l1' }).cells.map((c) => ({ ...c, reps }));
  }

  console.log(`refreshing reference for ${model} @ ${endpoint.id}`);
  console.log(`  ${cells.length} cells x ${reps} = ${cells.length * reps} logical probes`);
  console.log(`  cells: ${cells.map((c) => `${c.task_id}|${c.lang}`).join(', ')}`);
  console.log(`  fingerprint protocol: ${fpProtocol} — ${FINGERPRINT_PROTOCOLS[fpProtocol].note}\n`);

  const { samples, counters, reasoningRate } = await runBattery({
    probe: fingerprintProbeFactory(fpProtocol)({ baseUrl: endpoint.base_url, apiKey }),
    model, cells, reps, role: 'subject',
    // 🔴 Matches how the existing reference was built, and is now recorded in the file
    // so the next comparison cannot get it wrong by accident.
    applyReasoningTrace: false,
    onProgress: ({ done, total }) => process.stdout.write(`\r  ${done}/${total}   `),
  });

  const r = rates(samples, { logicalSamples: counters.probes });
  console.log(`\n  valid ${(r.valid_rate * 100).toFixed(1)}%   response ${(r.response_rate * 100).toFixed(1)}%   ` +
              `reasoning ${(reasoningRate * 100).toFixed(1)}%`);
  if (r.valid_rate < 0.8) {
    console.error('\n✗ valid rate below 80% — refusing to store this as a reference.');
    console.error('  A reference is ground truth; collecting one from a wobbling endpoint bakes the wobble in.');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const fingerprint = { ...(existing?.fingerprint ?? {}) };
  const cellMeta = { ...(existing?.cell_collected_utc ?? {}) };
  const kept = (existing?.samples ?? []).filter((s) => !cells.some((c) => `${c.task_id}|${c.lang}` === s.cell));

  const fresh = [];
  const counts = {};
  for (const s of samples) {
    if (s.state !== 'valid' || s.normalized == null) continue;
    const cell = `${s.task_id}|${s.lang}`;
    (counts[cell] ??= {})[s.normalized] = ((counts[cell] ?? {})[s.normalized] ?? 0) + 1;
  }
  for (const s of samples) {
    fresh.push({
      cell: `${s.task_id}|${s.lang}`, rep: s.rep, normalized: s.normalized,
      answer_class: s.answer_class, prompt_tokens: s.usage?.prompt_tokens ?? null,
      reasoning_len: s.reasoning_len ?? null,
    });
  }
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    fingerprint[cell] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n]));
    cellMeta[cell] = now;
    const before = existing?.fingerprint?.[cell];
    if (before) {
      const top = (d) => Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ');
      console.log(`  ${cell.padEnd(20)} was: ${top(before)}   now: ${top(fingerprint[cell])}`);
    }
  }

  if (existing) {
    const backup = refPath.replace(/\.json$/, `.${(existing.collected_utc ?? 'old').slice(0, 10)}.json`);
    if (!existsSync(backup)) { copyFileSync(refPath, backup); console.log(`\n  previous kept at ${path.relative(ROOT, backup)}`); }
  }

  writeFileSync(refPath, `${JSON.stringify({
    ...(existing ?? {}),
    model,
    source_label: endpoint.id,
    genuineness_basis: existing?.genuineness_basis ?? 'supply chain confirmed',
    collected_utc: now,
    // 🔴 Per cell, because a partial refresh leaves a file with mixed dates and a reader
    // has to be able to see which parts are stale.
    cell_collected_utc: cellMeta,
    // 🔴 The setting this file was normalised under. Its absence is what let a mismatch
    // go unnoticed until someone read the raw answers by hand.
    normalisation: { apply_reasoning_trace: false },
    // 🔴 Part of "the same way". The identical question over the two wires produces
    // different distributions, so a reference is only usable by runs on its own protocol.
    fingerprint_protocol: fpProtocol,
    fingerprint_params: FINGERPRINT_PROTOCOLS[fpProtocol].params,
    battery: which, reps,
    cells: Object.keys(fingerprint),
    reasoning_rate: reasoningRate,
    valid_rate: r.valid_rate,
    fingerprint,
    samples: [...kept, ...fresh],
  }, null, 2)}\n`);
  console.log(`\n  probes ${counters.probes} / attempts ${counters.http_attempts}`);
  console.log(`  saved ${path.relative(ROOT, refPath)}`);
});

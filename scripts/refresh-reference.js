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
import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg, runMain } from '../src/lib/cli.js';
import { fingerprintProbeFactory, FINGERPRINT_PROTOCOLS } from '../src/probe/http/fingerprint-probe.js';
import { referencePath, loadReference, referenceExists } from '../src/lib/reference-store.js';
import { runBattery, QUICK_CELLS, fullCells } from '../src/probe/runner.js';
import { loadVendorConfig } from '../src/normalize/index.js';
import { rates } from '../src/contracts.js';
import { selectCells } from '../src/probe/cells.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/refresh-reference.js --endpoint <id> --model M [--cells l1|all] [--reps 30]

  --endpoint <id>  已知正版端点的 id —— 参照只能从正版采
  --model M        模型（默认取该端点的 models.subject）
  --cells l1       只重采 L1 用的三格（90 次，最省）
  --cells all      重采快筛 8 格（240 次）
  --cells full     重采论文 paper-1 全部 40 格（1200 次）—— L2 精度靠这个
                   L2 对「格子」做 bootstrap，6 个格子的区间再怎么加采样也窄不下来
  --reps N         每格次数（默认 30，与既有参照同口径）
  --fp-protocol P  指纹层协议: chat（默认，论文口径）| responses（官方 API 唯一可行的）

⚠️ 两种协议的分布不同，参照与待测必须用同一种。文件会记下它，比较时会校验。`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
// The usage text has always said a reference may only come from a genuine endpoint;
// nothing enforced it. A reference IS the ground truth every later verdict is measured
// against, so collecting one from an unverified endpoint does not produce a weaker
// answer — it produces a confident wrong one, for every endpoint, until someone notices.
if (!endpoint.genuine) {
  console.error(`${endpoint.id} is not marked genuine in config/endpoints.json.`);
  console.error('A reference is this project\'s ground truth. Establish genuineness outside this tool');
  console.error('(vendor API by definition, or a confirmed supply chain), then set "genuine": true.');
  process.exit(2);
}
const model = args.model ?? endpoint.models.subject;
const reps = Number(args.reps ?? 30);
const which = args.cells === true ? 'l1' : (args.cells ?? 'l1');
if (!['l1', 'all', 'full'].includes(which)) {
  console.error(`--cells takes l1 | all | full, got ${which}`);
  process.exit(2);
}
const fpProtocol = args['fp-protocol'] === true ? 'chat' : (args['fp-protocol'] ?? 'chat');
if (!FINGERPRINT_PROTOCOLS[fpProtocol]) {
  console.error(`--fp-protocol takes chat or responses, got ${fpProtocol}`);
  process.exit(2);
}

await runMain(async () => {
  // 🔴 Addressed by (model, protocol). While this was keyed on the model alone, a partial
  // refresh on one wire inherited the cells it did not re-collect from the other wire and
  // stamped the result with a single protocol — see src/lib/reference-store.js.
  const refPath = referencePath(model, fpProtocol);
  const existing = referenceExists(model, fpProtocol) ? loadReference(model, fpProtocol) : null;

  let cells;
  if (which === 'full') {
    // 🔴 The whole paper-1 battery: 10 tasks × 4 languages. This is what buys PRECISION —
    // L2 bootstraps over CELLS, so six of them give a coarse, heavy-tailed interval no
    // matter how many reps each one gets. Going from 6 live cells to ~35 narrows the
    // interval far more than any extra sampling within the same six would.
    const { prompts } = loadVendorConfig();
    cells = fullCells(prompts).map(([task_id, lang]) => ({ task_id, lang, reps }));
  } else if (which === 'all') {
    cells = QUICK_CELLS.map(([task_id, lang]) => ({ task_id, lang, reps }));
  } else {
    const control = endpoint.models.control;
    if (!existing) {
      console.error(`--cells l1 picks the three cells by comparing this model's reference with the ` +
                    `control's, and there is no ${fpProtocol} reference for ${model} yet.`);
      console.error(`Bootstrap the protocol with --cells all first.`);
      process.exit(2);
    }
    // Same protocol on both sides, or the cell ranking is computed across wires.
    const controlRef = loadReference(control, fpProtocol);
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
    // 🔴 Never skip the backup. The name is only date-precise, so a second refresh on the
    // same day used to find the name taken and quietly keep nothing — the version about
    // to be overwritten would have been the one with no copy anywhere.
    const stem = refPath.replace(/\.json$/, `.${(existing.collected_utc ?? 'old').slice(0, 10)}`);
    let backup = `${stem}.json`;
    for (let n = 2; existsSync(backup); n += 1) backup = `${stem}-${String(n).padStart(2, '0')}.json`;
    copyFileSync(refPath, backup);
    console.log(`\n  previous kept at ${path.relative(ROOT, backup)}`);
  } else {
    mkdirSync(path.dirname(refPath), { recursive: true });
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

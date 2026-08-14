#!/usr/bin/env node
// L1 — screen one endpoint against the stored genuine reference. 15 probes.
//
//   node scripts/screen.js --endpoint <id> [--model M]
//
// Cheap enough to run often; that is the point. It answers "does this still match what
// we stored", not "which model is this" — for that, and for a substitution the screen
// only hints at, go to L2.
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg, runMain } from '../src/lib/cli.js';
import { fingerprintProbeFactory, assertSameProtocol } from '../src/probe/http/fingerprint-probe.js';
import { screenL1 } from '../src/layers/l1-screen.js';
import { genuineScreenScores } from '../src/layers/genuine-history.js';
import { loadEndpoints } from '../src/lib/config.js';
import { writeResultFile } from '../src/layers/result-file.js';
import { VERDICT } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/screen.js --endpoint <id> [--model M] [--control M]

  --endpoint <id>  端点 id，见 config/endpoints.json
  --model M        待验模型（默认取该端点的 models.subject）
  --control M      对照模型，只用于选格与标定阈值（不采样，不花额度）`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
const subject = args.model ?? endpoint.models.subject;
const control = args.control ?? endpoint.models.control;

const refPath = (m) => path.join(ROOT, 'reference', `genuine-${m}.json`);
for (const m of [subject, control]) {
  if (!existsSync(refPath(m))) {
    console.error(`missing reference/genuine-${m}.json — collect it once from a known-genuine endpoint:`);
    console.error(`  node scripts/probe-endpoint.js --endpoint <genuine-id> --model ${m}`);
    process.exit(2);
  }
}

await runMain(async () => {
  const refSubject = JSON.parse(readFileSync(refPath(subject), 'utf8'));
  const refControl = JSON.parse(readFileSync(refPath(control), 'utf8'));

  console.log(`screening ${subject} @ ${endpoint.id} (${endpoint.base_url})`);
  console.log(`  reference collected ${refSubject.collected_utc ?? '(unknown)'}`);

  // The reference dictates the protocol — it is the fixed side of the comparison.
  const fpProtocol = assertSameProtocol(refSubject.fingerprint_protocol, refSubject.fingerprint_protocol ?? 'chat');
  console.log(`  fingerprint protocol: ${fpProtocol} (from the reference)`);
  const probe = fingerprintProbeFactory(fpProtocol)({ baseUrl: endpoint.base_url, apiKey });
  const genuine = loadEndpoints().find((e) => e.genuine);
  const genuineScores = genuine
    ? genuineScreenScores({ endpointId: genuine.id, model: subject, referenceVersion: refSubject.collected_utc })
    : [];
  if (genuineScores.length) console.log(`  T_pass widened by ${genuineScores.length} live screens of ${genuine.id}`);

  const out = await screenL1({
    probe, model: subject, refSubject, refControl, genuineScores,
    onProgress: ({ done, total }) => process.stdout.write(`\r  ${done}/${total}   `),
  });
  const r = out.result;

  console.log(`\n\n  cells            ${out.meta.cells.join(', ')}`);
  console.log(`  thresholds       T_pass ${r.t_pass?.toFixed(6) ?? '—'}   T_fail ${r.t_fail?.toFixed(6) ?? '—'}`);
  console.log(`  S_screen         ${r.s_screen != null ? r.s_screen.toFixed(6) : '—'}`);
  if (r.noise_floor != null) console.log(`  noise floor      ${r.noise_floor.toFixed(6)}  (diagnostic only — never subtracted)`);
  console.log(`  valid rate       ${(r.valid_rate * 100).toFixed(1)}%   response rate ${(r.response_rate * 100).toFixed(1)}%`);
  console.log(`  live cells       ${r.live_cells}/${out.meta.cells.length}`);
  if (r.per_cell) {
    for (const [cell, v] of Object.entries(r.per_cell)) console.log(`    ${cell.padEnd(22)} ${v.toFixed(6)}`);
  }
  console.log(`  probes ${out.meta.probes} / attempts ${out.meta.http_attempts}`);

  const label = {
    [VERDICT.CONSISTENT]: '✅ consistent — matches the stored genuine reference',
    [VERDICT.SUSPECT]: '🔴 suspect — as far from the reference as a different model would be',
    [VERDICT.INCONCLUSIVE]: '⚠️  inconclusive — between the two thresholds',
    [VERDICT.NOT_APPLICABLE]: '✗ not applicable — this endpoint cannot produce single-pass completions',
  }[r.verdict];
  console.log(`\n  ${label}`);
  if (r.reason) console.log(`    ${r.reason}`);
  if (r.verdict !== VERDICT.CONSISTENT && r.verdict !== VERDICT.NOT_APPLICABLE) {
    console.log('    → 下一步：node scripts/verify-relay.js --endpoint ' + endpoint.id + '  (L2, 180 次)');
  }

  const file = writeResultFile({
    endpointId: endpoint.id, tier: 'l1',
    result: out.result, samples: out.samples,
    meta: { ...out.meta, auth_env: endpoint.auth_env, control },
  });
  console.log(`\n  saved ${path.relative(ROOT, file)}`);
});

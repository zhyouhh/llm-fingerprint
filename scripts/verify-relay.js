#!/usr/bin/env node
// L2 — calibrated verification against the stored genuine reference. 180 probes.
//
//   node scripts/verify-relay.js --endpoint <id> [--subject M] [--control M]
//
// Two gateways wrap requests differently, so a raw cross-endpoint distance conflates
// "different harness" with "different model". L2 also samples a CONTROL model that both
// sides serve and that is independently known genuine on both: its cross-endpoint
// distance H is pure harness effect. The subject's distance S is then judged against H
// rather than against an absolute threshold, and D — the two models measured against
// each other on the relay itself — sets the scale a real substitution would produce.
//
// This is the layer that can tell "wrapped differently" from "not the same model". L1
// cannot, which is why an L1 amber verdict is a reason to come here rather than a
// finding in itself.
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg, runMain } from '../src/lib/cli.js';
import { createChatProbe } from '../src/probe/http/chat.js';
import { calibrateL2, CONSISTENT_RATIO, SUSPECT_RATIO } from '../src/layers/l2-calibrate.js';
import { writeResultFile } from '../src/layers/result-file.js';
import { VERDICT } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/verify-relay.js --endpoint <id> [--subject M] [--control M]

  --endpoint <id>  端点 id，见 config/endpoints.json
  --subject M      待验模型（默认取该端点的 models.subject）
  --control M      对照模型 —— 必须双方都提供且已独立确认为正版`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
const subject = args.subject ?? endpoint.models.subject;
const control = args.control ?? endpoint.models.control;

const refPath = (m) => path.join(ROOT, 'reference', `genuine-${m}.json`);
for (const m of [subject, control]) {
  if (!existsSync(refPath(m))) {
    console.error(`missing reference/genuine-${m}.json — collect it once from a known-genuine endpoint:`);
    console.error(`  node scripts/refresh-reference.js --endpoint <genuine-id> --model ${m} --cells all`);
    process.exit(2);
  }
}

await runMain(async () => {
  const refSubject = JSON.parse(readFileSync(refPath(subject), 'utf8'));
  const refControl = JSON.parse(readFileSync(refPath(control), 'utf8'));

  console.log(`verifying ${subject} @ ${endpoint.id} (${endpoint.base_url})`);
  console.log(`  control ${control}   reference collected ${refSubject.collected_utc ?? '(unknown)'}`);

  const out = await calibrateL2({
    probe: createChatProbe({ baseUrl: endpoint.base_url, apiKey }),
    subject, control, refSubject, refControl,
    onProgress: ({ done, total, model }) => process.stdout.write(`\r  ${model} ${done}/${total}   `),
  });
  const r = out.result;

  console.log(`\n\n  cells used       ${out.meta.cells.join(', ')}`);
  console.log(`  noise floor      ${Number.isFinite(r.noise_floor) ? r.noise_floor.toFixed(4) : '—'}  (subtracted from all three)`);
  console.log('');
  console.log(`  H  harness       ${fmt(r.h)} → ${fmt(r.h_c)}   ${control} across endpoints, same model both sides`);
  console.log(`  S  subject       ${fmt(r.s)} → ${fmt(r.s_c)}   ${subject} across endpoints — the one being judged`);
  console.log(`  D  model scale   ${fmt(r.d)} → ${fmt(r.d_c)}   ${subject} vs ${control} on this relay`);
  console.log('');
  console.log(`  S/H = ${fmt(r.ratio)}   90% CI [${fmt(r.ratio_ci_lo)}, ${fmt(r.ratio_ci_hi)}]`);
  console.log(`    consistent needs S_c ≤ ${CONSISTENT_RATIO}×H_c AND the CI upper bound below ${CONSISTENT_RATIO}`);
  console.log(`    suspect     needs S_c ≥ ${SUSPECT_RATIO}×D_c`);
  console.log('');
  console.log(`  valid rate       subject ${(r.subject.valid_rate * 100).toFixed(1)}%   control ${(r.control.valid_rate * 100).toFixed(1)}%`);
  console.log(`  live cells       ${r.live_cells}`);
  if (r.low_confidence) console.log('  ⚠️  low confidence — valid rate between 20% and 80%');

  const label = {
    [VERDICT.CONSISTENT]: `✅ consistent — the harness explains the gap; no model difference is needed`,
    [VERDICT.SUSPECT]: `🔴 suspect — the gap approaches what a genuinely different model produces`,
    [VERDICT.INCONCLUSIVE]: '⚠️  inconclusive',
    [VERDICT.NOT_APPLICABLE]: '✗ not applicable — this endpoint cannot produce single-pass completions',
  }[r.verdict];
  console.log(`\n  ${label}`);
  if (r.reason) console.log(`    ${r.reason}`);

  // Reasoning effort is a separate axis: same model, cheaper setting. The answer
  // distribution cannot see it, so it is reported rather than folded into the verdict.
  console.log(`\n  reasoning-trace rate (effort proxy, NOT covered by this verdict):`);
  console.log(`    reference ${pct(refSubject.reasoning_rate)}   relay subject ${pct(r.reasoning_rate?.subject)}`);
  if (Math.abs((refSubject.reasoning_rate ?? 0) - (r.reasoning_rate?.subject ?? 0)) > 0.25) {
    console.log('    ⚠️  large gap — this relay may run the model at a lower reasoning effort.');
    console.log('       Confirm with scripts/quick-check.js; the fingerprint cannot see effort.');
  }

  console.log(`\n  probes ${out.meta.probes} / attempts ${out.meta.http_attempts}`);
  const file = writeResultFile({
    endpointId: endpoint.id, tier: 'l2',
    result: out.result, samples: out.samples,
    meta: { ...out.meta, auth_env: endpoint.auth_env },
  });
  console.log(`  saved ${path.relative(ROOT, file)}`);
});

function fmt(x) { return Number.isFinite(x) ? x.toFixed(4) : '—'; }
function pct(x) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—'; }

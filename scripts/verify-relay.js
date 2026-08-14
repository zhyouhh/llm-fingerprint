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
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg, runMain } from '../src/lib/cli.js';
import { fingerprintProbeFactory, assertSameProtocol } from '../src/probe/http/fingerprint-probe.js';
import { loadReference, resolveProtocol } from '../src/lib/reference-store.js';
import { calibrateL2, CONSISTENT_RATIO, SUSPECT_RATIO } from '../src/layers/l2-calibrate.js';
import { writeResultFile } from '../src/layers/result-file.js';
import { VERDICT } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/verify-relay.js --endpoint <id> [--subject M] [--control M] [--fp-protocol P]

  --endpoint <id>  端点 id，见 config/endpoints.json
  --subject M      待验模型（默认取该端点的 models.subject）
  --control M      对照模型 —— 必须双方都提供且已独立确认为正版
  --fp-protocol P  chat | responses —— 只有一种协议有参照时可省略
  --no-control     不采对照模型：探针减半，H 视为未测（分母走噪声地板），
                   D 改从两份参照算。⚠️ 外壳大的线路上不要用——外壳会被算到模型头上`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
const subject = args.subject ?? endpoint.models.subject;
const control = args.control ?? endpoint.models.control;
const sampleControl = args['no-control'] !== true;

await runMain(async () => {
  const fpProtocol = resolveProtocol({
    models: [subject, control],
    requested: args['fp-protocol'] === true ? null : (args['fp-protocol'] ?? null),
  });
  const refSubject = loadReference(subject, fpProtocol);
  const refControl = loadReference(control, fpProtocol);

  console.log(`verifying ${subject} @ ${endpoint.id} (${endpoint.base_url})`);
  console.log(`  control ${control}   reference collected ${refSubject.collected_utc ?? '(unknown)'}`);

  // Both references must agree with each other before either is compared to anything.
  assertSameProtocol(refSubject.fingerprint_protocol, refControl.fingerprint_protocol ?? 'chat');
  console.log(`  fingerprint protocol: ${fpProtocol} (from the references)`);

  const out = await calibrateL2({
    probe: fingerprintProbeFactory(fpProtocol)({ baseUrl: endpoint.base_url, apiKey }),
    subject, control, refSubject, refControl, fpProtocol, sampleControl,
    onProgress: ({ done, total, model }) => process.stdout.write(`\r  ${model} ${done}/${total}   `),
  });
  const r = out.result;

  console.log(`\n\n  cells used       ${out.meta.cells.join(', ')}`);
  console.log(`  noise floor      ${Number.isFinite(r.noise_floor) ? r.noise_floor.toFixed(4) : '—'}  (subtracted from all three)`);
  console.log('');
  console.log(sampleControl
    ? `  H  harness       ${fmt(r.h)} → ${fmt(r.h_c)}   ${control} across endpoints, same model both sides`
    : `  H  harness       NOT MEASURED — --no-control. Any harness effect lands on the model.`);
  console.log(`  S  subject       ${fmt(r.s)} → ${fmt(r.s_c)}   ${subject} across endpoints — the one being judged`);
  console.log(sampleControl
    ? `  D  model scale   ${fmt(r.d)} → ${fmt(r.d_c)}   ${subject} vs ${control} on this relay`
    : `  D  model scale   ${fmt(r.d)} → ${fmt(r.d_c)}   ${subject} vs ${control} in the references (not on this relay)`);
  console.log('');
  console.log(`  denominator      ${r.denominator_basis}`);
  console.log(`  S/H = ${fmt(r.ratio)}   90% CI [${fmt(r.ratio_ci_lo)}, ${fmt(r.ratio_ci_hi)}]`);
  console.log(`  S/D = ${fmt(r.sd_ratio)}   90% CI [${fmt(r.sd_ci_lo)}, ${fmt(r.sd_ci_hi)}]`);
  console.log(`    consistent needs the WHOLE S/H interval below ${CONSISTENT_RATIO}`);
  console.log(`    suspect     needs the WHOLE S/D interval at or above ${SUSPECT_RATIO}`);
  console.log('');
  console.log(`  valid rate       subject ${(r.subject.valid_rate * 100).toFixed(1)}%   ` +
              `control ${r.control ? `${(r.control.valid_rate * 100).toFixed(1)}%` : 'not sampled'}`);
  console.log(`  live cells       ${r.live_cells}`);
  if (r.low_confidence) console.log('  ⚠️  low confidence — valid rate between 20% and 80%');

  const label = {
    [VERDICT.CONSISTENT]: sampleControl
      ? `✅ consistent — the harness explains the gap; no model difference is needed`
      : `✅ consistent — the gap is inside the measurement noise (harness not measured)`,
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
  // 🔴 Direction matters. The old wording called any large gap "a lower reasoning
  // effort", which is wrong half the time: a HIGHER trace rate is more reasoning, not
  // less. Reporting a downgrade when the relay is doing the opposite is worse than
  // saying nothing, because the reader acts on it.
  const gap = (r.reasoning_rate?.subject ?? 0) - (refSubject.reasoning_rate ?? 0);
  if (Math.abs(gap) > 0.25) {
    console.log(`    ⚠️  ${(Math.abs(gap) * 100).toFixed(0)}pt ${gap < 0 ? 'BELOW' : 'ABOVE'} the reference.`);
    console.log(gap < 0
      ? '       Fewer traces than the genuine endpoint — consistent with a lower reasoning effort.'
      : '       MORE traces than the genuine endpoint — not a downgrade. Could be a higher effort\n' +
        '       default, a different harness, or a different upstream build.');
    console.log('       Either way the fingerprint cannot see effort; confirm with scripts/quick-check.js.');
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

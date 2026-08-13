#!/usr/bin/env node
// One-command relay verification against the stored genuine reference.
//
//   node scripts/verify-relay.js --endpoint <id> [--subject gpt-5.6-sol] [--control gpt-5.4]
//
// Only the relay under test is sampled. The genuine side comes from reference/,
// collected once — see reference/*.json for provenance and date.
//
// The method, in one paragraph: two gateways wrap requests differently, so a raw
// cross-endpoint distance conflates "different harness" with "different model". So we
// also sample a CONTROL model that both sides serve and that is independently known to
// be genuine on both. Its cross-endpoint distance H is pure harness effect. The
// subject's cross-endpoint distance S is then judged against H, not against an
// absolute threshold. S≈H means the harness explains everything and no model
// difference is needed. D — two genuinely different models measured on the relay
// itself — sets the scale a real substitution would produce.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg } from '../src/lib/cli.js';
import { createChatProbe } from '../src/probe/http/chat.js';
import { runBattery, QUICK_CELLS } from '../src/probe/runner.js';
import { jsd, MIN_N } from '../src/stats/jsd.js';
import { rates } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/verify-relay.js --endpoint <id> [--subject M] [--control M] [--reps 30]

  --endpoint <id>  端点 id，见 config/endpoints.json
  --subject M      待验模型（默认取该端点的 models.subject）
  --control M      对照模型（默认取该端点的 models.control）
  --reps N         每格采样次数（默认 30）`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
const subject = args.subject ?? endpoint.models.subject ?? 'gpt-5.6-sol';
const control = args.control ?? endpoint.models.control ?? 'gpt-5.4';
const reps = Number(args.reps ?? 30);

const refPath = (m) => path.join(ROOT, 'reference', `genuine-${m}.json`);
for (const m of [subject, control]) {
  if (!existsSync(refPath(m))) {
    console.error(`missing reference/genuine-${m}.json — collect it once from a known-genuine endpoint:`);
    console.error(`  node scripts/probe-endpoint.js --endpoint <genuine-id> --model ${m}`);
    process.exit(1);
  }
}

/** Rebuild a per-cell distribution from raw samples (optionally filtered). */
function fingerprint(samples, pred = null) {
  const counts = {};
  for (const s of samples) {
    if (s.answer_class !== 'valid') continue;
    if (pred && !pred(s)) continue;
    (counts[s.cell] ??= {})[s.normalized] = ((counts[s.cell] ?? {})[s.normalized] ?? 0) + 1;
  }
  const fp = {};
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    if (n < MIN_N) continue;
    fp[cell] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n]));
  }
  return fp;
}

const meanJsd = (a, b) => {
  const shared = Object.keys(a).filter((c) => b[c]);
  return shared.length
    ? { v: +(shared.reduce((s, c) => s + jsd(a[c], b[c]), 0) / shared.length).toFixed(4), cells: shared.length }
    : { v: NaN, cells: 0 };
};

async function sample(model, role) {
  const logical = QUICK_CELLS.length * reps;
  process.stdout.write(`\n  sampling ${model} (${QUICK_CELLS.length}x${reps} = ${logical} logical probes)\n`);
  const probe = createChatProbe({ baseUrl: endpoint.base_url, apiKey });
  const { samples: collected, counters, reasoningRate } = await runBattery({
    probe, model, cells: QUICK_CELLS, reps, role, applyReasoningTrace: false,
    onProgress: ({ done, total }) => process.stdout.write(`\r    ${done}/${total}   `),
  });
  // 判定语义④ — the denominator is the LOGICAL sample count of this side, never the
  // number that happened to come back.
  const r = rates(collected, { logicalSamples: logical });
  const samples = collected.map((s) => ({
    cell: `${s.task_id}|${s.lang}`, normalized: s.normalized, answer_class: s.answer_class,
    state: s.state, prompt_tokens: s.usage?.prompt_tokens ?? null, reasoning_len: s.reasoning_len ?? null,
  }));
  process.stdout.write(`\r    done: ${counters.probes} probes / ${counters.http_attempts} attempts, ` +
    `valid ${(r.valid_rate * 100).toFixed(0)}%, reasoning ${(reasoningRate * 100).toFixed(1)}%\n`);
  return { samples, counters, reasoningRate, valid: r.valid_rate, rates: r };
}

console.log(`verifying ${subject} @ ${endpoint.id} (${endpoint.base_url})`);
console.log(`  control model: ${control}   reference: reference/genuine-*.json`);

const relaySubject = await sample(subject, 'subject');
const relayControl = await sample(control, 'control');
// 🔴 Either side below the gate kills the run: subject-fine/control-dead computes to a
// comfortable-looking average while H and D are both garbage.
if (relaySubject.valid < 0.2 || relayControl.valid < 0.2) {
  console.log('\n✗ endpoint cannot produce single-pass completions — method does not apply.');
  process.exit(2);
}

const refSubject = JSON.parse(readFileSync(refPath(subject), 'utf8'));
const refControl = JSON.parse(readFileSync(refPath(control), 'utf8'));

const H = meanJsd(fingerprint(refControl.samples), fingerprint(relayControl.samples));
const S = meanJsd(fingerprint(refSubject.samples), fingerprint(relaySubject.samples));
const D = meanJsd(fingerprint(relaySubject.samples), fingerprint(relayControl.samples));

console.log('\n  H  harness term      (%s, same model both sides) = %s  [%d cells]', control, H.v, H.cells);
console.log('  S  subject          (%s, cross-endpoint)       = %s  [%d cells]', subject, S.v, S.cells);
console.log('  D  different-model scale (%s vs %s on relay)   = %s', subject, control, D.v);
console.log('  S / H = %s', (S.v / H.v).toFixed(2));

console.log('\nverdict:');
if (!Number.isFinite(S.v) || !Number.isFinite(H.v)) console.log('  inconclusive — insufficient overlapping cells');
else if (S.v <= H.v * 1.5) console.log(`  ✅ ${subject} is consistent with the genuine reference (harness explains the gap)`);
else if (S.v >= D.v * 0.7) console.log(`  ✗ gap approaches the different-model scale — substitution likely`);
else console.log('  ⚠️  between the two scales — inconclusive; re-run with --reps 50 or the full battery');

// Reasoning effort is a separate axis: same model, cheaper setting. The answer
// distribution cannot see it, so report it rather than folding it into the verdict.
const rr = (x) => (x * 100).toFixed(1) + '%';
console.log('\nreasoning-trace rate (effort proxy, NOT covered by the verdict):');
console.log(`  reference ${subject}: ${rr(refSubject.reasoning_rate)}   relay: ${rr(relaySubject.reasoningRate)}`);
if (Math.abs(refSubject.reasoning_rate - relaySubject.reasoningRate) > 0.25) {
  console.log('  ⚠️  large gap — the relay may run this model at a lower reasoning effort.');
  console.log('     Confirm with a hard reasoning task that has a single verifiable answer.');
}

mkdirSync(path.join(ROOT, 'baselines'), { recursive: true });
const out = path.join(ROOT, 'baselines', `verify-${endpoint.id}-${subject}.json`);
writeFileSync(out, JSON.stringify({
  endpoint: endpoint.base_url, endpoint_id: endpoint.id, subject, control, reps, H, S, D,
  probes: relaySubject.counters.probes + relayControl.counters.probes,
  http_attempts: relaySubject.counters.http_attempts + relayControl.counters.http_attempts,
  reasoning: { reference: refSubject.reasoning_rate, relay: relaySubject.reasoningRate },
  samples: { subject: relaySubject.samples, control: relayControl.samples },
}, null, 1));
console.log(`\n  saved ${path.relative(ROOT, out)}`);

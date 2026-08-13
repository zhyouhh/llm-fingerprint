#!/usr/bin/env node
// L0 — profile one endpoint.
//
//   node scripts/profile.js --endpoint <id> [--only l0a|l0b]
//
// L0a costs zero completions. L0b costs ~24 probes (2 on a chat-only endpoint) and is
// where "what does this thing accept" gets answered — including whether logprobs / seed
// / n exist at all, which is the cheapest way to tell a bare API from a subscription
// gateway.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveEndpointArg, runMain } from '../src/lib/cli.js';
import { createGetProbe } from '../src/probe/http/get.js';
import { createResponsesClient } from '../src/probe/http/responses.js';
import { profileL0a, profileL0b, ACCEPTANCE_KEYS } from '../src/layers/l0-profile.js';
import { mergeCollections, writeResultFile } from '../src/layers/result-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const USAGE = `node scripts/profile.js --endpoint <id> [--only l0a|l0b] [--model M]

  --endpoint <id>  端点 id，见 config/endpoints.json
  --only l0a       只跑零请求画像（0 次补全请求）
  --only l0b       只跑能力探测（~24 次）
  --model M        L0b 用的模型（默认取该端点的 models.subject）`;

const { endpoint, apiKey } = resolveEndpointArg(args, { usage: USAGE });
const only = args.only === true ? null : args.only;
if (only && !['l0a', 'l0b'].includes(only)) {
  console.error(`--only takes l0a or l0b, got ${only}`);
  process.exit(2);
}
const model = args.model ?? endpoint.models.subject;

await runMain(async () => {
  console.log(`profiling ${endpoint.id} (${endpoint.base_url})  protocol=${endpoint.protocol}`);

  let a = null;
  let b = null;

  if (only !== 'l0b') {
    const get = createGetProbe();
    a = await profileL0a({ get, baseUrl: endpoint.base_url, origin: endpoint.origin, apiKey });
    const r = a.result;
    console.log('\nL0a — zero completion requests');
    console.log(`  endpoint kind        ${r.endpoint_kind}`);
    console.log(`  /models reachable    ${r.models_endpoint_reachable}${r.model_count != null ? ` (${r.model_count} models)` : ''}`);
    console.log(`  /api/status          ${r.status_endpoint ? 'open' : 'absent'}`);
    const marker = Object.keys(r.headers).filter((h) => /^x-(oneapi|newapi|cpa|server)/i.test(h));
    console.log(`  marker headers       ${marker.length ? marker.join(', ') : '(none)'}`);
    console.log(`  probes ${a.meta.probes} / attempts ${a.meta.http_attempts}`);
    // 🔴 Stated every time: this is a display signal. It never gates L1/L2, in either
    // direction — some endpoints serve chat without /models, and some do the reverse.
    console.log('  ⚠️  L0a is profile only — it cannot say whether fingerprinting will work');
  }

  if (only !== 'l0a') {
    if (!model) {
      console.error('L0b needs a model: pass --model or set models.subject in config/endpoints.json');
      process.exit(2);
    }
    const client = createResponsesClient({ baseUrl: endpoint.base_url, apiKey });
    b = await profileL0b({ client, model, protocol: endpoint.protocol });
    const r = b.result;
    console.log(`\nL0b — capability probing (${model})`);
    if (r.effort_probe_unavailable) {
      console.log('  effort / reasoning.mode: not probed — this endpoint is chat-only, and those');
      console.log('    parameters only take effect on the Responses API. Not "unsupported": unasked.');
    }
    const yes = ACCEPTANCE_KEYS.filter((k) => r.acceptance[k] === true);
    const no = ACCEPTANCE_KEYS.filter((k) => r.acceptance[k] === false);
    const unknown = ACCEPTANCE_KEYS.filter((k) => r.acceptance[k] === null);
    const unasked = ACCEPTANCE_KEYS.filter((k) => r.acceptance[k] === 'not_probed');
    console.log(`  accepted (${yes.length})   ${yes.join(', ') || '(none)'}`);
    console.log(`  refused  (${no.length})   ${no.join(', ') || '(none)'}`);
    // 🔴 Kept apart from 'refused' on purpose: a 5xx says nothing about the parameter,
    // and reporting it as unsupported is how a wobbly minute becomes a permanent claim.
    if (unknown.length) console.log(`  unknown  (${unknown.length})   ${unknown.join(', ')}  ← 端点当时 5xx/网络失败，非参数结论`);
    if (unasked.length) console.log(`  unasked  (${unasked.length})   ${unasked.join(', ')}`);

    for (const cap of ['top_logprobs', 'seed', 'n']) {
      if (r.acceptance[cap] === true) {
        console.log(`  ✱ ${cap} is supported — this looks like a bare API. One logprobs request`);
        console.log('    verifies the model far more directly than sampling ever can.');
        break;
      }
    }
    if (r.juice_by_effort) {
      const readable = Object.entries(r.juice_by_effort).filter(([, v]) => v != null);
      console.log(`  juice                ${readable.length ? readable.map(([k, v]) => `${k}=${v}`).join(' ') : '(unreadable)'}`);
      console.log('    ⚠️  red light only — the prompt is public and the answer is one number');
    }
    console.log(`  injected preamble    ${r.injection_tokens != null ? `~${r.injection_tokens} tokens` : '(not measurable)'}`);
    console.log(`  probes ${b.meta.probes} / attempts ${b.meta.http_attempts}`);
  }

  const merged = mergeCollections([a, b], { resultKeys: ['l0a', 'l0b'] });
  const file = writeResultFile({
    endpointId: endpoint.id, tier: 'l0',
    result: merged.result, samples: merged.samples,
    meta: { model: model ?? null, protocol: endpoint.protocol, auth_env: endpoint.auth_env, only: only ?? 'both' },
  });
  console.log(`\n  probes ${merged.meta.probes} / attempts ${merged.meta.http_attempts}`);
  console.log(`  saved ${path.relative(ROOT, file)}`);
});

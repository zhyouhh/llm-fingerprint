#!/usr/bin/env node
// A fake relay, so the whole run flow can be exercised for free.
//
//   node ui/scripts/stub-relay.js --serves gpt-5.6-luna --port 8791
//
// It advertises a set of model names and answers every fingerprint probe by sampling from
// the reference distribution of whatever model `--serves` names — regardless of which
// model the request asked for. Point the UI at it selling `gpt-5.6-sol` while it serves
// `gpt-5.6-luna` and the verdict path has to notice.
//
// 🔴 This exists because of a rule this project paid for twice: a variable-name typo burned
// 435 probes and an unchecked precondition burned 1200. Any path that spends quota gets
// driven end to end against a stub before it is pointed at a real endpoint.
//
// Flags:
//   --serves <spec>    what it actually answers from. Either one model name (every request
//                      gets that model, imitating a relay whose whole backend is swapped —
//                      which also collapses D and must NOT be reported as consistent), or a
//                      map `sold=actual,sold2=actual2` where unlisted names are served
//                      honestly. The map form is the ordinary substitution: one flagship
//                      name quietly points elsewhere while the control model is genuine.
//   --advertise a,b    model ids to list at GET /models (default: every reference)
//   --port <n>         default 8791
//   --inject <n>       claim this many extra input tokens, imitating a gateway preamble
//   --empty <0..1>     fraction of probes that return an empty completion (reasoning burn)
//   --fail <0..1>      fraction of probes that return HTTP 500
//   --oneapi           stamp x-oneapi-request-id and serve an open /api/status

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendorConfig } from '../../src/normalize/vendor-config.js';
import { mulberry32 } from '../../src/lib/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (argv.includes(`--${name}`) ? true : fallback);
};

const SERVES_SPEC = String(flag('serves', 'gpt-5.6-sol'));
const PORT = Number(flag('port', 8791));
const INJECT = Number(flag('inject', 0));
const EMPTY = Number(flag('empty', 0));
const FAIL = Number(flag('fail', 0));
const ONEAPI = argv.includes('--oneapi');

const bundle = JSON.parse(readFileSync(path.join(ROOT, 'ui/public/data/references.json'), 'utf8'));
const refs = bundle.responses ?? [];
const byModel = new Map(refs.map((r) => [r.model, r]));

/** `luna` → serve luna for everything. `a=b,c=d` → serve b for a, d for c, honest otherwise. */
const substitutions = new Map();
let blanket = null;
for (const part of SERVES_SPEC.split(',').map((s) => s.trim()).filter(Boolean)) {
  const [sold, actual] = part.split('=').map((s) => s.trim());
  if (actual) substitutions.set(sold, actual);
  else blanket = sold;
}
for (const name of [blanket, ...substitutions.values()].filter(Boolean)) {
  if (!byModel.has(name)) {
    console.error(`--serves names ${name}, which is not in the reference bundle.\n` +
                  `Have: ${refs.map((r) => r.model).join(', ')}`);
    process.exit(2);
  }
}

/** Which reference actually answers a request for `sold`. */
const actualFor = (sold) => byModel.get(blanket ?? substitutions.get(sold) ?? sold) ?? null;

const ADVERTISE = String(flag('advertise', refs.map((r) => r.model).join(','))).split(',').filter(Boolean);

// Reverse index: prompt text → cell. The probe sends only the question, so this is how the
// stub knows which distribution to answer from — the same lookup a real model does
// implicitly.
const { prompts } = loadVendorConfig();
const cellByPrompt = new Map();
for (const task of prompts.tasks) {
  for (const [lang, text] of Object.entries(task.prompts ?? {})) {
    cellByPrompt.set(text.trim(), `${task.id}|${lang}`);
  }
}

const rng = mulberry32(0xC0FFEE);

/** Draw one answer from a cell's stored distribution, for whichever model really answers. */
function sample(cell, sold) {
  const dist = actualFor(sold)?.fingerprint?.[cell];
  if (!dist) return null;
  let x = rng();
  for (const [answer, p] of Object.entries(dist)) {
    x -= p;
    if (x <= 0) return answer;
  }
  return Object.keys(dist).at(-1) ?? null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body, headers = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      ...(ONEAPI ? { 'x-oneapi-request-id': `stub-${Date.now()}` } : {}),
      ...headers,
    });
    res.end(payload);
  };

  if (url.pathname.endsWith('/api/status')) {
    return ONEAPI
      ? send(200, { success: true, data: { version: 'stub-oneapi', start_time: 0 } })
      : send(404, { error: { message: 'no status endpoint', type: 'not_found' } });
  }

  if (url.pathname.endsWith('/models')) {
    return send(200, { object: 'list', data: ADVERTISE.map((id) => ({ id, object: 'model', owned_by: 'stub' })) });
  }

  if (url.pathname.endsWith('/responses') && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}

    if (FAIL > 0 && rng() < FAIL) {
      return send(500, { error: { message: 'stub: synthetic upstream failure', type: 'server_error' } });
    }

    const input = String(body.input ?? '').trim();
    const sold = body.model ?? 'unknown';
    const cell = cellByPrompt.get(input);
    const burned = EMPTY > 0 && rng() < EMPTY;
    const answer = burned ? '' : (cell ? sample(cell, sold) ?? 'OK' : 'OK');
    const inputTokens = Math.round(input.length / 4) + 7 + INJECT;

    return send(200, {
      id: `resp_stub_${Date.now()}`,
      object: 'response',
      // The relay reports the name that was ASKED FOR — that is the whole deception being
      // simulated. What it actually served is `SERVES`.
      model: body.model ?? 'unknown',
      status: burned ? 'incomplete' : 'completed',
      ...(burned ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output: burned ? [] : [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      }],
      reasoning: body.reasoning ?? null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: burned ? 16 : 1,
        output_tokens_details: { reasoning_tokens: burned ? 16 : 0 },
        total_tokens: inputTokens + (burned ? 16 : 1),
      },
    });
  }

  send(404, { error: { message: `stub has no ${url.pathname}`, type: 'not_found' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub relay on http://localhost:${PORT}/v1`);
  console.log(blanket
    ? `  actually serves : ${blanket} for EVERY model name (D collapses — expect a refusal to judge)`
    : `  substitutions   : ${[...substitutions].map(([a, b]) => `${a} → ${b}`).join(', ') || '(none — honest relay)'}`);
  console.log(`  advertises      : ${ADVERTISE.join(', ')}`);
  console.log(`  injection       : +${INJECT} tokens${ONEAPI ? '  · One API headers' : ''}`);
  if (EMPTY) console.log(`  empty completions: ${(EMPTY * 100).toFixed(0)}%`);
  if (FAIL) console.log(`  synthetic 500s   : ${(FAIL * 100).toFixed(0)}%`);
  console.log(`\nPoint the UI at http://localhost:${PORT}/v1 with any key.`);
});

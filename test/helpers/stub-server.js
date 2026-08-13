// A local HTTP stub for the outbound contract tests.
//
// 🔴 Assertions are made at the NETWORK BOUNDARY — what bytes arrived, on which path,
// how many times. Counting calls to some internal function instead would test whichever
// layer happens to hold the retry loop today, and that is exactly the thing allowed to
// move.

import http from 'node:http';

/**
 * @param {Array<object|function>} script  one entry per incoming request; the last entry
 *   repeats once exhausted. Each entry is {status?, json?, text?, headers?} or a
 *   function (req, index) returning one.
 */
export async function startStub(script = [{ status: 200, json: {} }]) {
  const received = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const index = received.length;
      received.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
        json: (() => { try { return JSON.parse(body); } catch { return null; } })(),
      });

      const entry = script[Math.min(index, script.length - 1)];
      const spec = typeof entry === 'function' ? entry(req, index) : entry;
      const status = spec?.status ?? 200;
      const headers = { 'content-type': 'application/json', ...(spec?.headers ?? {}) };
      const payload = spec?.text !== undefined ? spec.text : JSON.stringify(spec?.json ?? {});
      res.writeHead(status, headers);
      res.end(payload);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    received,
    get count() { return received.length; },
    async close() { await new Promise((r) => server.close(r)); },
  };
}

/** A minimally valid chat completion body. */
export const chatOk = (content = '7', model = 'stub-model') => ({
  model,
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { completion_tokens: 1 },
});

/** A minimally valid Responses body, shaped like test/fixtures/responses-sample.json. */
export const responsesOk = (text = 'OK', model = 'stub-model') => ({
  id: 'resp_stub',
  object: 'response',
  status: 'completed',
  model,
  output: [{
    id: 'msg_stub',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
  }],
  usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } },
});

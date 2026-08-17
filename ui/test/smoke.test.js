// Smoke tests for the pieces that broke, or could break, without saying so.
//
// 🔴 Why this file exists: the first render of the site was missing its header and its
// entire hero, and nothing errored. `h('div', someNode)` had been treating the node as a
// props object, Object.entries() of a DOM node is empty, and so the child was silently
// dropped. That is the same failure shape as this project's most expensive bugs — no
// exception, no symptom, just a result that quietly means something else.
//
// Run with `npm --prefix ui test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTarget, assertHostAllowed, ProxyError, ALLOWED_SUFFIXES, isLocalDeployment }
  from '../worker/proxy.js';
import { normaliseBaseUrl, proxyPaths, EndpointError } from '../src/core/endpoint.js';
import { rehydrate } from '../src/core/references.js';
import { band } from '../src/components/heatmap.js';
import { modeOf, displayCells, discriminatingCells } from '../src/components/fingerprint-grid.js';
import { headline, scaleOf } from '../src/components/verdict.js';
import { fmt } from '../src/ui/dom.js';
import { pickControl, clientsFor, identifyRun, distributionOf, tierAvailability } from '../src/core/engine.js';
import { identification, MIN_ID_CELLS, SEPARATION } from '../../src/layers/model-matrix.js';
import { validAnswersByCell } from '../../src/stats/noise.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = JSON.parse(readFileSync(path.join(ROOT, 'ui/public/data/references.json'), 'utf8'));

/* ── the proxy is the only server-side code; its guards are the security model ── */

const inbound = (p, host = 'llmfingerprint.z0y0h.work') => new URL(`https://${host}${p}`);

test('proxy rewrites /p/<host>/<path> onto https', () => {
  assert.equal(resolveTarget(inbound('/p/api.relay.com/v1/responses')).href,
    'https://api.relay.com/v1/responses');
  assert.equal(resolveTarget(inbound('/p/api.relay.com:8443/v1/chat/completions')).href,
    'https://api.relay.com:8443/v1/chat/completions');
  // L0a's status probe hangs off the origin, not the versioned base.
  assert.equal(resolveTarget(inbound('/p/api.relay.com/api/status')).href,
    'https://api.relay.com/api/status');
});

test('proxy refuses anything that is not a public https host', () => {
  for (const target of ['/p/localhost/v1/models', '/p/127.0.0.1/v1/models',
                        '/p/foo.internal/v1/models', '/p/box.local/v1/models',
                        '/p/singlelabel/v1/models', '/p/[::1]/v1/models']) {
    assert.throws(() => resolveTarget(inbound(target)), ProxyError, `should refuse ${target}`);
  }
});

test('proxy forwards only the probe paths', () => {
  for (const suffix of ALLOWED_SUFFIXES) {
    assert.ok(resolveTarget(inbound(`/p/api.relay.com/v1${suffix}`)));
  }
  for (const bad of ['/v1/secret', '/admin', '/v1/models/../../etc', '/v1/responses/stream']) {
    assert.throws(() => resolveTarget(inbound(`/p/api.relay.com${bad}`)), ProxyError, `should refuse ${bad}`);
  }
});

test('proxy will not be pointed at itself', () => {
  assert.throws(() => resolveTarget(inbound('/p/llmfingerprint.z0y0h.work/v1/models'),
    'llmfingerprint.z0y0h.work'), ProxyError);
});

test('the local escape hatch is keyed on the INBOUND host, never a flag', () => {
  assert.equal(isLocalDeployment('localhost'), true);
  assert.equal(isLocalDeployment('127.0.0.1'), true);
  assert.equal(isLocalDeployment('llmfingerprint.z0y0h.work'), false);
  // Served from localhost: the stub relay is reachable, over http.
  assert.equal(resolveTarget(new URL('http://localhost:5177/p/localhost:8791/v1/responses')).href,
    'http://localhost:8791/v1/responses');
  // Served from production: the same target is refused. This is the whole safety argument
  // for having a dev escape hatch at all.
  assert.throws(() => resolveTarget(inbound('/p/localhost:8791/v1/responses')), ProxyError);
});

test('assertHostAllowed rejects a malformed port rather than passing it through', () => {
  assert.throws(() => assertHostAllowed('relay.com:notaport'), ProxyError);
  assert.equal(assertHostAllowed('relay.com:8443'), 'relay.com:8443');
});

/* ── endpoint normalisation ───────────────────────────────────────────────── */

test('a typed base URL becomes proxy paths the probe layer can append to', () => {
  const n = normaliseBaseUrl('https://api.relay.com/v1/');
  assert.equal(n.url, 'https://api.relay.com/v1');
  const { baseUrl, origin } = proxyPaths(n.url);
  assert.equal(baseUrl, '/p/api.relay.com/v1');
  assert.equal(origin, '/p/api.relay.com');
  // What the outbound clients actually build:
  assert.equal(`${baseUrl}/responses`, '/p/api.relay.com/v1/responses');
  assert.equal(`${origin}/api/status`, '/p/api.relay.com/api/status');
});

test('the guessed /v1 is reported, not applied silently', () => {
  const n = normaliseBaseUrl('api.relay.com');
  assert.equal(n.url, 'https://api.relay.com/v1');
  assert.equal(n.addedPath, true, 'the UI has to be able to show what it filled in');
  assert.equal(n.addedScheme, true);
  assert.equal(normaliseBaseUrl('https://api.relay.com/openai/v1').addedPath, false);
});

test('http and non-public hosts are refused', () => {
  assert.throws(() => normaliseBaseUrl('http://api.relay.com/v1'), EndpointError);
  assert.throws(() => normaliseBaseUrl(''), EndpointError);
});

/* ── the slim reference must be the same measurement ──────────────────────── */

test('rehydrate reproduces exactly the answer pools noiseFloor draws from', () => {
  for (const [protocol, list] of Object.entries(bundle)) {
    for (const lean of list) {
      const pools = validAnswersByCell(rehydrate(lean).samples);
      assert.deepEqual(pools, lean.answers,
        `${protocol}/${lean.model}: rehydrate must round-trip, ORDER INCLUDED — ` +
        'drawWithReplacement indexes into these arrays and a reordered pool moves the noise floor');
    }
  }
});

test('every shipped reference declares the protocol of its own directory', () => {
  for (const [protocol, list] of Object.entries(bundle)) {
    for (const lean of list) {
      assert.equal(lean.fingerprint_protocol, protocol, `${lean.model} is filed under the wrong wire`);
      assert.ok(Object.keys(lean.fingerprint).length > 0, `${lean.model} has no cells`);
    }
  }
});

test('references carry no endpoint URL or key', () => {
  const serialised = JSON.stringify(bundle);
  assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}/.test(serialised), 'a key-shaped string is in the shipped bundle');
  assert.ok(!/https?:\/\//.test(serialised), 'an endpoint URL is in the shipped bundle');
});

test('identifyRun will not invent a valid rate from the rows that happen to be present', async () => {
  // 🔴 The denominator of a valid rate is the PLANNED logical sample count — `rates()` in
  // contracts.js refuses to derive it, precisely because probes that failed hard never
  // reached the samples array and would drop out of the denominator. A record saved
  // mid-flight has exactly that shape: 120 rows where 210 were planned reads as 100% valid,
  // and the thin-run bar that had withheld the name in `evaluateL2` re-opens as a red named
  // accusation the moment somebody opens the report. So the rate is handed in, not computed.
  await assert.rejects(
    () => identifyRun({ samples: [], protocol: 'responses', sold: 'gpt-5.6-sol' }),
    /validRate/,
    'omitting it must be a usage error, not a silent recomputation');
  // Explicit null stays legal — it means "this record does not say", which withholds. It
  // gets past the guard and dies later on the browser-only reference fetch, and that is the
  // distinction being asserted: the guard fires on omission and only on omission.
  await assert.rejects(
    () => identifyRun({ samples: [], protocol: 'responses', sold: 'gpt-5.6-sol', validRate: null }),
    (err) => !/validRate/.test(String(err?.message ?? err)),
    'explicit null must be accepted rather than rejected as missing');

  // And the distribution helper must not hand one back either — the rate is not derivable
  // from these rows, so it must not appear to be.
  const dist = distributionOf([], { role: 'subject' });
  assert.deepEqual(Object.keys(dist).sort(), ['dist', 'reps'],
    'distributionOf must not return a validRate it computed from samples.length');
});

test('every withheld reason is reachable on the page and names its own bar', () => {
  // 🔴 A reason that is correct, complete and never rendered is worth nothing. `headline()`
  // reaches `withheldGloss` only through `leaning`, and the 'floor' branch inherited
  // `leaning: false` — so the sentence explaining an unknowable resolution limit existed in
  // the source and could not appear on any screen.
  const base = {
    nearest: 'gpt-5.6-luna', distance: 0.05, runner_up: 'gpt-5.6-sol', runner_up_distance: 0.4,
    separation: 3.5, separation_lo: 2.1, rank_stability: 1, floor: 0.11, cells: 20,
    refuted_by: [], leaning: true, impostor: false, model: null,
  };
  const glosses = new Map();
  for (const withheld of ['valid_rate', 'cells', 'floor', 'stability', 'separation', 'refuted']) {
    const id = { ...base, withheld, refuted_by: withheld === 'refuted' ? [{ model: 'gpt-5.5' }] : [] };
    const head = headline({ verdict: 'inconclusive', model: 'gpt-5.6-sol', identification: id });
    assert.equal(head.named, false);
    assert.match(head.title, /gpt-5\.6-luna/, `${withheld}: the finding still reaches the reader`);
    assert.ok(head.gloss.length > 10, `${withheld}: has a gloss`);
    glosses.set(withheld, head.gloss);
  }
  // Each bar must produce a DIFFERENT sentence — otherwise the enum is decoration and the
  // page is back to describing the separation whatever actually failed.
  assert.equal(new Set(glosses.values()).size, glosses.size,
    `two bars share one explanation:\n${[...glosses].map(([k, v]) => `${k}: ${v}`).join('\n')}`);
  // And the two that must not mention a multiple, because a multiple is not what failed.
  for (const k of ['valid_rate', 'cells', 'floor']) {
    assert.ok(!/倍/.test(glosses.get(k)),
      `${k}: quoting a separation here describes a bar that passed — ${glosses.get(k)}`);
  }
});

test('a run with no role labels is not averaged into one side', () => {
  // 🔴 `role` is not a contract field — `makeSample` pins only kind/state/attempts — so an
  // archive can legitimately carry none, and `rejudge` splits by MODEL. The old filter was
  // `role && s.role && s.role !== role`, which lets a sample with no role through for every
  // role: subject and control merged into one distribution, 15 samples of A and 15 of B
  // read as one 50/50 cell. If some third reference happens to look like that mixture, the
  // page names it while the CLI, reading only A's rows, does not — the same file, two
  // verdicts.
  const rows = (model, answer) => Array.from({ length: 15 }, (_, i) => ({
    state: 'valid', normalized: answer, task_id: 'c1', lang: 'en', rep: i, model,
  }));
  const both = [...rows('A', 'x'), ...rows('B', 'y')];

  const a = distributionOf(both, { model: 'A' }, 10);
  assert.deepEqual(a.dist['c1|en'], { x: 1 }, 'selecting model A must see only A');
  assert.equal(a.reps['c1|en'], 15);
  const b = distributionOf(both, { model: 'B' }, 10);
  assert.deepEqual(b.dist['c1|en'], { y: 1 });

  // And a file that labels only some of its rows is refused rather than half-filtered.
  const halfLabelled = [...rows('A', 'x'), ...rows(undefined, 'y')];
  assert.throws(() => distributionOf(halfLabelled, { model: 'A' }, 10), /cannot be told apart/);
  // 🔴 And a file with NO labels at all, which is the case that used to fall through to
  // "keep every row" and average the two sides into one distribution.
  const unlabelled = [...rows(undefined, 'x'), ...rows(undefined, 'y')];
  assert.throws(() => distributionOf(unlabelled, { model: 'A' }, 10), /cannot be told apart/,
    'no labels at all is not proof that there is only one side');
});

test('every real call site supplies the arguments the required-parameter guards demand', () => {
  // 🔴 A guard on a required parameter only helps if it fires in a TEST — and asserting
  // that `identifyRun({})` throws does not exercise `history.js`, which is where the miss
  // actually was: making `validRate` required broke the entire history page, and every unit
  // test stayed green because none of them opens it. Twice now a required-parameter change
  // has left a call site behind and only review caught it.
  //
  // So this reads the sources. Crude, and it is the crudeness that makes it hold: any new
  // call site anywhere under ui/src has to carry the argument or this goes red.
  const srcDir = path.join(ROOT, 'ui', 'src');
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(srcDir);

  // fn → the argument every call of it must name
  const required = { identifyRun: 'validRate', clientsFor: 'cancelled' };
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const [fn, arg] of Object.entries(required)) {
      // Each call, from `fn(` to the matching close paren at depth 0.
      let i = src.indexOf(`${fn}(`);
      while (i !== -1) {
        const before = src[i - 1] ?? '';
        // Skip the declaration itself and any `foo.identifyRun(`-style member access.
        const isDecl = /\bfunction\s+$/.test(src.slice(Math.max(0, i - 30), i));
        if (!isDecl && !/[.\w]/.test(before)) {
          let depth = 0;
          let j = i + fn.length;
          for (; j < src.length; j += 1) {
            if (src[j] === '(') depth += 1;
            else if (src[j] === ')') { depth -= 1; if (depth === 0) break; }
          }
          // 🔴 The key has to be at the TOP level of the argument object, not merely
          // present in the call text. `identifyRun({ options: { validRate: null } })` and a
          // mention inside a comment both satisfy a substring test while still throwing at
          // runtime — a scanner that passes on those tests its own regex, not the code.
          const inner = src.slice(i + fn.length + 1, j);
          const stripped = inner
            .replace(/\/\*[\s\S]*?\*\//g, ' ')       // block comments
            .replace(/\/\/[^\n]*/g, ' ')             // line comments
            .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");   // string literals
          const topLevelKeys = new Set();
          let objDepth = 0;
          // Brackets, `key:` pairs, and `{ key }` shorthand — the last matters because that
          // is exactly how `clientsFor({ baseUrl, apiKey, protocol, cancelled })` passes it.
          const TOKENS = /[{}[\]()]|([A-Za-z_$][\w$]*)\s*:|(?<=[{,]\s*)([A-Za-z_$][\w$]*)\s*(?=[,}])/g;
          for (const m of stripped.matchAll(TOKENS)) {
            const key = m[1] ?? m[2];
            if (key !== undefined) { if (objDepth === 1) topLevelKeys.add(key); continue; }
            if ('{(['.includes(m[0])) objDepth += 1;
            else objDepth -= 1;
          }
          assert.ok(topLevelKeys.has(arg),
            `${path.relative(ROOT, file)} calls ${fn}() without a top-level ${arg} — the ` +
            `guard would throw at runtime and this is the only place that would notice.\n` +
            `top-level keys seen: ${[...topLevelKeys].join(', ') || '(none)'}\n${src.slice(i, j + 1)}`);
        }
        i = src.indexOf(`${fn}(`, i + 1);
      }
    }
  }
});

test('clientsFor refuses to build a client that cannot hear Stop', () => {
  // 🔴 Omission and intent must not look the same. `cancelled = null` as a default read as
  // "this caller has no cancel flag", and the call site that merely FORGOT — L2's preflight —
  // was indistinguishable from L0, which genuinely has none. The cost of forgetting is that
  // a worker parked in a shared 429 cooldown sits out the full pause and then retries, after
  // the user pressed Stop. Same precedent as `applyReasoningTrace` and `refs`.
  const base = { baseUrl: 'https://relay.example/v1', apiKey: 'k', protocol: 'responses' };
  assert.throws(() => clientsFor(base), /cancelled/,
    'a missing cancel flag has to be a usage error, not a silent null');
  assert.doesNotThrow(() => clientsFor({ ...base, cancelled: null }),
    'and explicit null must still be allowed, for callers that really have no cancel path');
  assert.doesNotThrow(() => clientsFor({ ...base, cancelled: () => false }));
});

/* ── the headline: which of two true answers the page leads with ──────────── */

/**
 * Built through the real `identification()` from src/, never hand-written — the point of
 * these cases is that the UI applies NO rule of its own, so a fixture that skipped the
 * shared function would test a rule that does not exist.
 */
const idFor = ({ measured, refs, sold }) => identification(
  fingerprintOf(measured),
  refs.map(([model, answers]) => ({
    model,
    fingerprint: fingerprintOf(answers),
    // Real references scatter, and the resolution floor is measured from these — a
    // deterministic fixture has a floor of zero and identification correctly refuses it.
    samples: answers.flatMap((a, i) => Array.from({ length: 30 },
      (_, k) => ({ cell: `c${i}|en`, answer_class: 'valid', normalized: k % 5 === 0 ? `${a}-alt` : a }))),
  })),
  sold, { reps: 15, validRate: 1 });

/** 80/20 in every cell, matching the sample pools above so the fingerprints agree. */
const fingerprintOf = (answers) => Object.fromEntries(
  answers.map((a, i) => [`c${i}|en`, { [a]: 0.8, [`${a}-alt`]: 0.2 }]));

const rep = (answer, n) => Array.from({ length: n }, () => answer);
const WIDE_N = MIN_ID_CELLS + 4;

test('a name for a model you did not buy outranks the verdict', () => {
  // The run this exists for: verdict inconclusive (the control had been substituted too,
  // so the scale collapsed) while identification named a different model outright.
  const id = idFor({
    measured: rep('luna', WIDE_N),
    refs: [['gpt-5.6-sol', rep('sol', WIDE_N)], ['gpt-5.6-luna', rep('luna', WIDE_N)]],
    sold: 'gpt-5.6-sol',
  });
  const head = headline({ verdict: 'inconclusive', model: 'gpt-5.6-sol', identification: id });
  assert.equal(head.tone, 'bad');
  assert.equal(head.named, true);
  assert.match(head.title, /gpt-5\.6-sol/);
  assert.match(head.title, /gpt-5\.6-luna/);
});

test('every multiple on screen divides two numbers that are also on screen', () => {
  // 🔴 The separation divides by `max(distance, floor)`, and on a real substitution the
  // floor is what binds — so the headline printed "0.0460 … 0.3918 … 3.2 倍" and a reader
  // dividing those two got 8.5. Not a wrong number: an unverifiable one, which is the same
  // defect as the run that printed S/H 1.94 while judging on 20.8. Whatever the sentence
  // quotes has to be reproducible from the figures beside it.
  const id = idFor({
    measured: rep('luna', WIDE_N),
    refs: [['gpt-5.6-sol', rep('sol', WIDE_N)], ['gpt-5.6-luna', rep('luna', WIDE_N)]],
    sold: 'gpt-5.6-sol',
  });
  const denom = scaleOf(id);
  assert.ok(denom > id.distance,
    'the fixture must be one where the floor binds, or it proves nothing');
  assert.ok(Math.abs(id.runner_up_distance / denom - id.separation) < 1e-9,
    'the quoted multiple must be runner-up ÷ the scale the page shows');

  const head = headline({ verdict: 'inconclusive', model: 'gpt-5.6-sol', identification: id });
  assert.match(head.gloss, new RegExp(fmt(denom).replace('.', '\\.')),
    'and that scale has to appear in the sentence, not only in the table further down');

  // 🔴 Both sentences that quote a multiple, not just the accusing one. The "最像的不是 X"
  // gloss carries the same figures and drifted independently once already.
  const unsure = idFor({
    measured: rep('x', WIDE_N),
    refs: [['gpt-5.6-sol', rep('a', WIDE_N)], ['gpt-5.6-luna', rep('b', WIDE_N)]],
    sold: 'gpt-5.6-sol',
  });
  assert.equal(unsure.withheld, 'separation', 'this fixture must fail on separation, not another bar');
  const leaning = headline({ verdict: 'inconclusive', model: 'gpt-5.6-sol', identification: unsure });
  assert.match(leaning.gloss, new RegExp(fmt(scaleOf(unsure)).replace('.', '\\.')),
    'the leaning gloss must name its denominator too');
});

test('the same shape, but the name IS what you bought, stays with the verdict', () => {
  const id = idFor({
    measured: rep('sol', WIDE_N),
    refs: [['gpt-5.6-sol', rep('sol', WIDE_N)], ['gpt-5.6-luna', rep('luna', WIDE_N)]],
    sold: 'gpt-5.6-sol',
  });
  assert.equal(id.impostor, false, 'matching what was sold is a confirmation');
  for (const [verdict, tone] of [['consistent', 'ok'], ['inconclusive', 'unknown'], ['suspect', 'bad']]) {
    const head = headline({ verdict, model: 'gpt-5.6-sol', identification: id });
    assert.equal(head.tone, tone, `${verdict} must keep its own tone`);
    assert.equal(head.named, false, 'naming the model you bought is not an accusation');
  }
});

test('an unseparated best guess never reaches the headline', () => {
  // Two candidates the measurement cannot tell apart: separation under the 2× bar.
  const id = idFor({
    measured: rep('x', WIDE_N),
    refs: [['gpt-5.6-sol', rep('a', WIDE_N)], ['gpt-5.6-luna', rep('b', WIDE_N)]],
    sold: 'gpt-5.6-sol',
  });
  assert.ok(!(id.separation >= SEPARATION), 'the fixture must actually be unseparated');
  const head = headline({ verdict: 'inconclusive', model: 'gpt-5.6-sol', identification: id });
  assert.equal(head.tone, 'unknown');
  assert.equal(head.named, false);
});

test('too few cells cannot accuse, however clean the separation looks', () => {
  // Measured: one endpoint named gpt-5.6-terra on 3 cells and 6 cells, gpt-5.6-luna and
  // gpt-5.6-sol on 29. A perfect match over three cells is not an identification.
  const build = (n) => idFor({
    measured: rep('terra', n),
    refs: [['gpt-5.6-sol', rep('sol', n)], ['gpt-5.6-terra', rep('terra', n)]],
    sold: 'gpt-5.6-sol',
  });
  // Under the floor the references cannot support a name at all, so they are set aside as
  // candidates rather than ranked and then rejected — and the exclusion is reported.
  const thin = build(MIN_ID_CELLS - 1);
  assert.equal(thin.model, null);
  assert.ok(thin.dropped_candidates.length > 0, 'a shrunken candidate set is never silent');
  assert.equal(headline({ verdict: 'inconclusive', model: 'gpt-5.6-sol', identification: thin }).named, false);

  const enough = build(MIN_ID_CELLS);
  assert.equal(headline({ verdict: 'inconclusive', model: 'gpt-5.6-sol', identification: enough }).named, true,
    'the floor is inclusive at MIN_ID_CELLS');
});

test('a run that produced no usable completions names nothing', () => {
  // valid_rate under the gate: evaluateL2 passes identification: null for exactly this.
  const head = headline({ verdict: 'not_applicable', model: 'gpt-5.6-sol', identification: null });
  assert.equal(head.named, false);
  assert.equal(head.tone, 'na');
});

test('no identification at all still yields a headline', () => {
  const head = headline({ verdict: 'consistent', model: 'gpt-5.6-sol', identification: null });
  assert.equal(head.tone, 'ok');
  assert.equal(head.named, false);
});

/* ── the yardstick model is chosen, never asked about ─────────────────────── */

/** A full library: every pair shares `n` cells, all of them live and all calibratable. */
const healthy = (models, n = 40) => ({
  cells: models.map(() => models.map(() => n)),
  live: models.map(() => models.map(() => n)),
  pairFloors: models.map(() => models.map(() => 0.05)),
});

test('pickControl ignores what the endpoint sells, because it is never sampled', () => {
  const models = ['a', 'b', 'c'];
  const matrix = {
    models,
    matrix: [[0.04, 0.20, 0.45], [0.20, 0.03, 0.30], [0.45, 0.30, 0.05]],
    ...healthy(models),
  };
  // An endpoint selling only 'a' used to be unrunnable at L2: the control had to be on
  // offer. With no sampling that constraint is gone.
  assert.equal(pickControl({ subject: 'a', matrix }).control, 'c');
  assert.equal(pickControl({ subject: 'a', available: ['a'], matrix }).control, 'c');
  assert.equal(pickControl({ subject: 'b', matrix }).control, 'c');
  // A model with no row in the map has no yardstick, and says so rather than guessing.
  assert.equal(pickControl({ subject: 'unknown-model', matrix }).control, null);
});

test('pickControl is deterministic when two candidates tie', () => {
  const models = ['a', 'z', 'b'];
  const matrix = {
    models,
    matrix: [[0.04, 0.3, 0.3], [0.3, 0.04, 0.1], [0.3, 0.1, 0.04]],
    ...healthy(models),
  };
  assert.equal(pickControl({ subject: 'a', matrix }).control, 'b', 'ties break by name, not by array order');
});

test('pickControl counts cells that can DISCRIMINATE, not cells that are shared', () => {
  // 🔴 `matrix.cells` is "both references can be compared here"; `selectCells` then throws
  // away every cell where the two agree, because a cell both models answer identically
  // cannot tell them apart. Counting the shared number produced both errors at once:
  //   · `thin` shares 40 cells but only 2 discriminate → it would be chosen, and then L1
  //     has 2 cells to screen on and L2's gate refuses the run outright;
  //   · a pair with 10 live cells would be rejected although L1 needs only 3.
  const models = ['sold', 'thin', 'wide'];
  const matrix = {
    models,
    matrix: [[0.04, 1.00, 0.50], [1.00, 0.03, 0.60], [0.50, 0.60, 0.05]],
    cells: [[40, 40, 40], [40, 40, 40], [40, 40, 40]],
    live: [[0, 2, 40], [2, 0, 2], [40, 2, 0]],
    pairFloors: models.map(() => models.map(() => 0.05)),
  };
  const r = pickControl({ subject: 'sold', matrix });
  assert.equal(r.control, 'wide', 'the farther candidate cannot discriminate, so it is not chosen');
  assert.equal(r.liveCells, 40);
  assert.deepEqual(r.rejected.map((c) => c.model), ['thin']);
  assert.match(r.rejected[0].reason, /有区分度/);

  // Ten live cells is fine — L1 needs three. The old shared-cell bar of twelve rejected it.
  const ten = { ...matrix, live: [[0, 10, 2], [10, 0, 2], [2, 2, 0]] };
  assert.equal(pickControl({ subject: 'sold', matrix: ten }).control, 'thin');

  // And when nothing discriminates there is no yardstick, said plainly rather than by
  // picking the least-bad option and failing three minutes later.
  const none = { ...matrix, live: [[0, 1, 1], [1, 0, 1], [1, 1, 0]] };
  assert.equal(pickControl({ subject: 'sold', matrix: none }).control, null);
});

test('pickControl will not choose a pair whose floor cannot be computed', () => {
  // 🔴 A reference carrying a fingerprint but no samples keeps its cells — it is refused on
  // other grounds — and produces a NaN pair floor. The map knows that comparison has no
  // resolution limit; choosing it anyway starts a run whose D rests on a fingerprint
  // nothing can scale, and identification withholds while S/H/D goes ahead regardless.
  const models = ['sold', 'bare', 'ok'];
  const matrix = {
    models,
    matrix: [[0.04, 1.00, 0.50], [1.00, 0.03, 0.60], [0.50, 0.60, 0.05]],
    cells: models.map(() => models.map(() => 40)),
    live: models.map(() => models.map(() => 40)),
    pairFloors: [[0.04, NaN, 0.05], [NaN, 0.03, NaN], [0.05, NaN, 0.05]],
  };
  const r = pickControl({ subject: 'sold', matrix });
  assert.equal(r.control, 'ok', 'the uncalibratable pair is not chosen even though it is farther');
  assert.deepEqual(r.rejected.map((c) => c.model), ['bare']);
  assert.match(r.rejected[0].reason, /噪声地板/);
});

test('a tier is offered only when ITS yardstick exists', () => {
  // 🔴 L1 screens on three cells; the identification route will not name a model under
  // twelve. One boolean over both tiers meant a control clearing only the lower bar still
  // enabled L2 — which promises "which model is it" and then spends 150 probes to arrive at
  // `withheld: 'cells'`, guaranteed before the run starts.
  // 🔴 The MATRIX goes in, not a pre-built yardstick: the two bars that decide — 3 for the
  // screen, 12 for naming — have to be inside the thing under test, or changing them back
  // in the view leaves every test green.
  const known = new Set(['sold', 'near', 'far']);
  const mk = (liveNear, liveFar) => ({
    models: ['sold', 'near', 'far'],
    matrix: [[0.04, 0.30, 0.50], [0.30, 0.03, 0.40], [0.50, 0.40, 0.05]],
    cells: [[40, 40, 40], [40, 40, 40], [40, 40, 40]],
    live: [[0, liveNear, liveFar], [liveNear, 0, 20], [liveFar, 20, 0]],
    pairFloors: [[0.04, 0.05, 0.05], [0.05, 0.03, 0.05], [0.05, 0.05, 0.05]],
  });

  const both = tierAvailability({ subject: 'sold', known, matrix: mk(20, 40) });
  assert.deepEqual([both.l1, both.l2], [true, true]);
  assert.equal(both.controlL2, 'far', 'L2 runs against the yardstick that can support it');

  // Something clears three live cells; nothing clears twelve.
  const screenOnly = tierAvailability({ subject: 'sold', known, matrix: mk(5, 4) });
  assert.equal(screenOnly.l1, true, 'the screen still runs');
  assert.equal(screenOnly.l2, false, 'but the naming tier is not offered');
  assert.equal(screenOnly.controlL2, '', 'and it reports having no L2 yardstick at all');

  // Nothing clears even three.
  const neither = tierAvailability({ subject: 'sold', known, matrix: mk(2, 1) });
  assert.deepEqual([neither.l1, neither.l2], [false, false]);

  // And a subject with no reference disables both, whatever the map says.
  const noSubject = tierAvailability({ subject: 'unknown', known, matrix: mk(40, 40) });
  assert.deepEqual([noSubject.l1, noSubject.l2], [false, false]);
});

/* ── display logic ────────────────────────────────────────────────────────── */

test('the hero grid does not lead with a cell the library measured once', () => {
  // 🔴 The most "discriminating" cell by a unique-answer count is exactly the cell nobody
  // measured: one sample, one unique answer, sorts first. It would then lead the hero grid
  // — presented to a reader as the clearest evidence in the library — on the one cell that
  // selection, the matrix and every verdict layer have already refused to use.
  const wide = Array.from({ length: 4 }, (_, i) => `w${i}|en`);
  const thinCell = 'thin|en';
  const ref = (model, answer, unique) => ({
    model,
    fingerprint: {
      ...Object.fromEntries(wide.map((c) => [c, { [answer]: 1 }])),
      [thinCell]: { [unique]: 1 },
    },
    samples: [
      ...wide.flatMap((c) => Array.from({ length: 30 },
        () => ({ cell: c, answer_class: 'valid', normalized: answer }))),
      // one sample, and a different answer in every model — maximum apparent signal
      { cell: thinCell, answer_class: 'valid', normalized: unique },
    ],
  });
  const refs = [ref('a', 'x', 'p'), ref('b', 'x', 'q'), ref('c', 'y', 'r')];
  const order = discriminatingCells(refs);
  assert.ok(!order.includes(thinCell),
    `the one-sample cell must not be offered at all, and it would sort FIRST: ${order.join(', ')}`);
  assert.ok(order.length === wide.length);

  // 🔴 And the asymmetric case, which a per-model filter followed by a union lets through:
  // only A is thin on that cell, B and C carry it properly. The grid draws EVERY model's
  // answer in every listed cell, so listing it puts A's one-sample answer on screen through
  // a different door — exactly the answer no decision layer would use.
  const fat = (model, answer, unique) => {
    const r = ref(model, answer, unique);
    r.samples = [
      ...r.samples.filter((x) => x.cell !== thinCell),
      ...Array.from({ length: 30 }, () => ({ cell: thinCell, answer_class: 'valid', normalized: unique })),
    ];
    return r;
  };
  const mixed = [ref('a', 'x', 'p'), fat('b', 'x', 'q'), fat('c', 'y', 'r')];
  assert.ok(!discriminatingCells(mixed).includes(thinCell),
    'a cell one displayed model measured once is not shown for the others either');
});

test('modeOf picks the most likely answer, not the first', () => {
  assert.deepEqual(modeOf({ 47: 0.2, 57: 0.8 }), { answer: '57', p: 0.8 });
  assert.deepEqual(modeOf({}), { answer: null, p: 0 });
  assert.deepEqual(modeOf(undefined), { answer: null, p: 0 });
});

test('displayCells mixes discriminating cells with ones that never move', () => {
  const refs = bundle.responses;
  const cells = displayCells(refs, { total: 16, stable: 4 });
  assert.equal(cells.length, 16);
  assert.equal(new Set(cells).size, 16, 'no cell may appear twice');

  const answersFor = (cell) => new Set(refs.map((r) => modeOf(r.fingerprint[cell]).answer));
  const moving = cells.filter((c) => answersFor(c).size > 1).length;
  assert.ok(moving >= 8, `expected most cells to discriminate, got ${moving}`);
  assert.ok(moving < 16, 'the point of the tail is that some cells never move');
});

test('heatmap bands put "indistinguishable" at the alarming end', () => {
  assert.equal(band(0.5), 0);
  assert.equal(band(1), 0, '1× exactly is still inside the noise floor');
  assert.equal(band(1.01), 1);
  assert.equal(band(4.6), 2);      // the closest real pair: gpt-5.3-codex ↔ gpt-5.4
  assert.equal(band(100), 5);
  assert.equal(band(NaN), -1);
});

test('the bands actually spread the real data instead of piling into one step', () => {
  // A ramp whose steps are never used is a ramp that teaches nothing — the first cut had
  // three of six empty and drew the whole map in a single colour.
  const m = JSON.parse(readFileSync(path.join(ROOT, 'ui/public/data/model-matrix.json'), 'utf8')).responses;
  const used = new Set();
  for (let i = 0; i < m.models.length; i += 1) {
    for (let j = 0; j < m.models.length; j += 1) {
      if (i === j) continue;
      // 🔴 The SAME divisor the heatmap uses: this pair's own floor, measured on the cells
      // it shares. Dividing by `max(floors[i], floors[j])` here tested a rule the UI no
      // longer applies — set every off-diagonal `pairFloors` to NaN and the real heatmap
      // goes entirely "unknown" while this stayed green.
      assert.ok(Number.isFinite(m.pairFloors?.[i]?.[j]),
        `pairFloors[${i}][${j}] must be exported and finite — the heatmap divides by it`);
      used.add(band(m.matrix[i][j] / m.pairFloors[i][j]));
    }
  }
  assert.ok(used.size >= 3, `only ${used.size} band(s) in use across 45 pairs: ${[...used]}`);
  assert.ok(!used.has(0), 'a pair inside the noise floor would mean the method cannot separate two official models');
  // And the count the control picker reads has to be there too, or every candidate looks
  // like it has zero discriminating cells and the whole library is refused.
  assert.ok(Number.isFinite(m.live?.[0]?.[1]), '`live` must be in the exported matrix');
});

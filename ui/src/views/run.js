import { h, clear, duration, int, pct } from '../ui/dom.js';
import { normaliseBaseUrl, EndpointError } from '../core/endpoint.js';
import { listModels, runL0, runL1, runL2, estimate, pickControl, clientsFor, DEFAULT_CONCURRENCY } from '../core/engine.js';
import { referencesFor, loadMatrix, isStale, ageInDays } from '../core/references.js';
import { liveGrid } from '../components/fingerprint-grid.js';
import { selectCells } from '../../../src/probe/cells.js';
import { runBattery } from '../../../src/probe/runner.js';
import { renderReport } from './report.js';
import { saveRun, saveActive, clearActive, runId, listRuns } from '../core/store.js';

const PROTOCOL = 'responses';

/** Working state. The key lives here and nowhere else — never in storage, never in a URL. */
const state = {
  typed: '',
  baseUrl: null,
  apiKey: '',
  models: [],
  subject: '',
  control: '',
  tier: 'l1',
  sampleControl: true,
  concurrency: DEFAULT_CONCURRENCY,
};

export async function view() {
  const root = h('div.page.page--narrow');
  const refs = await referencesFor(PROTOCOL);
  const matrix = (await loadMatrix())[PROTOCOL];
  const known = new Set(refs.map((r) => r.model));

  const stage = h('div');
  root.append(
    h('div.eyebrow', '检测'),
    h('h1', { style: { fontSize: 'var(--step-3)', fontWeight: '300', margin: 'var(--gap-2) 0 var(--gap-4)' } },
      '接上你的中转'),
    stage);

  showSetup();

  /* ── stage 1: setup ─────────────────────────────────────────────────── */

  function showSetup(banner = null) {
    clear(stage);
    const errBox = h('div');
    if (banner) errBox.append(banner);

    const urlInput = h('input.input', {
      type: 'url', placeholder: 'https://api.example.com/v1', value: state.typed,
      autocomplete: 'off', spellcheck: 'false',
      oninput: (e) => { state.typed = e.target.value; },
    });
    const keyInput = h('input.input', {
      type: 'password', placeholder: 'sk-…', value: state.apiKey,
      autocomplete: 'off', spellcheck: 'false',
      oninput: (e) => { state.apiKey = e.target.value; },
    });
    const urlNote = h('div.field-hint');
    const modelBox = h('div');

    const connect = h('button.btn.btn--primary', {
      type: 'button',
      onclick: async () => {
        clear(urlNote); clear(errBox); clear(modelBox);
        let normalised;
        try {
          normalised = normaliseBaseUrl(state.typed);
        } catch (err) {
          if (err instanceof EndpointError) { urlNote.append(h('span.field-error', err.message)); return; }
          throw err;
        }
        state.baseUrl = normalised.url;
        state.typed = normalised.url;
        urlInput.value = normalised.url;
        if (normalised.addedPath) {
          urlNote.append(h('span', `补上了常见的 ${normalised.path} —— 如果你的中转不在这个路径，改一下。`));
        }
        if (!state.apiKey.trim()) { errBox.append(h('div.banner', '还需要 API key —— 拉模型列表要用它。')); return; }

        connect.disabled = true;
        connect.replaceChildren(h('span.spinner'), ' 读模型列表');
        try {
          const { models, error, status } = await listModels({ baseUrl: state.baseUrl, apiKey: state.apiKey });
          if (error) {
            errBox.append(h('div.banner',
              h('strong', `拿不到模型列表（HTTP ${status ?? '—'}，${error.code}）`),
              h('p', { style: { margin: '0.35rem 0 0' } },
                error.message || '检查 Base URL 和 key。',
                ' 有些中转不实现 /models —— 那样也能继续，手动填模型名就行。'),
              h('button.btn.btn--sm', {
                type: 'button', style: { marginTop: 'var(--gap-2)' },
                onclick: () => { renderModelPicker(modelBox, [], known, matrix); },
              }, '手动填模型名')));
          } else {
            renderModelPicker(modelBox, models, known, matrix);
          }
        } finally {
          connect.disabled = false;
          connect.replaceChildren('连接并读取模型列表');
        }
      },
    }, '连接并读取模型列表');

    stage.append(
      errBox,
      h('div.card',
        h('div.field',
          h('label.field-label', 'Base URL'),
          urlInput,
          urlNote,
          h('div.field-hint', '中转的 OpenAI 兼容地址，通常以 /v1 结尾。只支持 https。')),
        h('div.field',
          h('label.field-label', 'API Key'),
          keyInput,
          h('div.field-hint',
            'key 存在你这个标签页的内存里。它会随每次探测经由本站的转发层发给中转——',
            '转发层不落盘、不写日志，',
            h('a', { href: '/about#privacy' }, '看它到底做了什么'),
            '。')),
        connect),
      modelBox);
  }

  /* ── stage 1b: pick models and depth ────────────────────────────────── */

  function renderModelPicker(box, models, knownSet, mtx) {
    state.models = models;
    const offered = models.length ? models : [...knownSet];
    const withRef = offered.filter((m) => knownSet.has(m));

    state.subject = withRef[0] ?? offered[0] ?? '';
    const auto = pickControl({ subject: state.subject, available: offered, matrix: mtx });
    state.control = auto.control ?? '';

    const subjectSel = h('select.select', {
      onchange: (e) => { state.subject = e.target.value; refreshControl(); refreshTiers(); },
    });
    const manual = h('input.input', {
      placeholder: '手动填模型名，如 gpt-5.6-sol', value: state.subject,
      oninput: (e) => { state.subject = e.target.value.trim(); refreshControl(); refreshTiers(); },
    });
    const controlSel = h('select.select', {
      onchange: (e) => { state.control = e.target.value; refreshTiers(); },
    });
    const controlNote = h('div.field-hint');
    const tierBox = h('div.tiers');
    const startBox = h('div', { style: { marginTop: 'var(--gap-3)' } });
    const refNote = h('div');

    if (models.length) {
      const known = withRef;
      const unknown = offered.filter((m) => !knownSet.has(m));
      subjectSel.append(
        known.length ? h('optgroup', { label: `有正版参照 · 可跑 L1 / L2（${known.length}）` },
          ...known.map((m) => h('option', { value: m }, m))) : null,
        unknown.length ? h('optgroup', { label: `无参照 · 只能跑 L0（${unknown.length}）` },
          ...unknown.map((m) => h('option', { value: m }, m))) : null);
      subjectSel.value = state.subject;
    }

    function refreshControl() {
      const picked = pickControl({ subject: state.subject, available: offered, matrix: mtx });
      clear(controlSel);
      for (const c of picked.candidates) {
        controlSel.append(h('option', { value: c.model }, `${c.model}  ·  与待验相距 ${c.distance.toFixed(3)}`));
      }
      if (!picked.candidates.length) {
        controlSel.append(h('option', { value: '' }, '（这个端点没有可用的对照模型）'));
      }
      state.control = picked.candidates.some((c) => c.model === state.control)
        ? state.control : (picked.control ?? '');
      controlSel.value = state.control;
      clear(controlNote);
      controlNote.append(picked.control
        ? h('span', '默认选了距离待验模型最远的那个——',
            h('strong', 'D 越大，「换了模型」的尺度越清楚'),
            '，选个近邻会让判定天然落进「说不准」。')
        : h('span.field-error', '这个端点不提供第二个有参照的模型，L2 只能用 --no-control 跑（外壳算不出来）。'));

      // Reference freshness is a real expiry, not a formality: after a vendor swaps
      // weights the old reference stops representing the genuine model.
      clear(refNote);
      const subjectRef = refs.find((r) => r.model === state.subject);
      if (subjectRef && isStale(subjectRef.collected_utc)) {
        refNote.append(h('div.note.note--warn',
          h('div.note-title', '参照可能过期了'),
          h('p', `${state.subject} 的正版参照采于 ${subjectRef.collected_utc?.slice(0, 10)}，`,
            `已经 ${Math.round(ageInDays(subjectRef.collected_utc))} 天。`,
            '厂商换过权重的话，旧参照就不代表正版了——这时判「不一致」要打折看。')));
      }
    }

    async function refreshTiers() {
      clear(tierBox); clear(startBox);
      const hasRef = knownSet.has(state.subject) && knownSet.has(state.control);

      const plans = await Promise.all([
        estimate({ tier: 'l0', protocol: PROTOCOL }),
        hasRef ? estimate({ tier: 'l1', model: state.subject, control: state.control, protocol: PROTOCOL }) : null,
        hasRef ? estimate({ tier: 'l2', model: state.subject, control: state.control, protocol: PROTOCOL,
                            sampleControl: state.sampleControl }) : null,
      ]);

      const defs = [
        ['l0', '画像', '端点类型、外壳注入量、透不透传 effort。不需要参照。', plans[0], true],
        ['l1', '快筛', '3 个高区分度格子对正版参照。绿灯就到此为止。', plans[1], hasRef],
        ['l2', '精确校准', '带对照模型，量出外壳再扣掉。唯一能分开「包装不同」和「不是同一个模型」的一层。', plans[2], hasRef],
      ];

      for (const [tier, name, what, plan, enabled] of defs) {
        tierBox.append(h('button.tier', {
          type: 'button', 'aria-pressed': String(state.tier === tier), disabled: !enabled,
          onclick: () => { state.tier = tier; refreshTiers(); },
        },
          h('div.tier-cost', plan
            ? `${tier.toUpperCase()} · ${int(plan.probes)} 次 · 约 ${duration(plan.minutes)}`
            : `${tier.toUpperCase()} · 需要参照`),
          h('div.tier-name', name),
          h('div.tier-what', enabled ? what : `参照库里没有 ${knownSet.has(state.subject) ? state.control : state.subject}`),
          plan?.cells ? h('div.tier-what.faint', `${plan.cells} 个活格 × ${plan.repsPerCell} 次${tier === 'l2' && state.sampleControl ? ' × 2 边' : ''}`) : null));
      }

      if (state.tier === 'l2') {
        startBox.append(h('label.check',
          h('input', {
            type: 'checkbox', checked: state.sampleControl,
            onchange: (e) => { state.sampleControl = e.target.checked; refreshTiers(); },
          }),
          h('span',
            h('strong', '同时采对照模型'), '（探针翻倍）。',
            h('br'),
            '关掉能省一半，但外壳就没测出来，会整个算到模型头上。',
            h('strong', '第一次测一个端点应该开着'),
            '——外壳大不大，只有采了对照才知道。')));
      }

      const plan = plans[['l0', 'l1', 'l2'].indexOf(state.tier)];
      startBox.append(h('div', { style: { marginTop: 'var(--gap-3)', display: 'flex', gap: 'var(--gap-2)', flexWrap: 'wrap', alignItems: 'center' } },
        h('button.btn.btn--primary', {
          type: 'button',
          disabled: !state.subject || (state.tier !== 'l0' && !hasRef),
          onclick: () => start(plan),
        }, `开始 ${state.tier.toUpperCase()} · ${plan ? int(plan.probes) : '?'} 次请求`),
        h('span.faint', { style: { fontSize: 'var(--step--1)' } },
          plan && plan.minutes > 2
            ? `预计 ${duration(plan.minutes)}，中途别关这个标签页`
            : '每次探测只要 1 个 output token，花费可忽略')));
    }

    clear(box);
    box.append(
      h('div.card',
        h('div.field',
          h('label.field-label', '待验模型'),
          models.length ? subjectSel : manual,
          h('div.field-hint', models.length
            ? `这个端点报了 ${models.length} 个模型，其中 ${withRef.length} 个我们有正版参照。`
            : '没读到模型列表，手填即可。')),
        h('div.field',
          h('label.field-label', '对照模型'),
          controlSel,
          controlNote),
        refNote),
      h('div.section',
        h('div.section-head', h('div.eyebrow', '测多深')),
        tierBox,
        startBox));

    refreshControl();
    refreshTiers();
  }

  /* ── stage 2: running ───────────────────────────────────────────────── */

  async function start(plan) {
    const cancel = { requested: false };
    clear(stage);

    const phase = h('div.progress-phase', '准备');
    const count = h('div.progress-count', '0 ', h('em', `/ ${int(plan?.probes ?? 0)}`));
    const fill = h('div.progress-fill');
    const gridBox = h('div', { style: { marginTop: 'var(--gap-3)' } });
    const log = h('div.faint', { style: { fontSize: 'var(--step--1)', marginTop: 'var(--gap-2)' } });

    const stopBtn = h('button.btn.btn--danger', {
      type: 'button',
      onclick: () => { cancel.requested = true; stopBtn.disabled = true; stopBtn.textContent = '正在停…'; },
    }, '停止');

    stage.append(
      h('div.card',
        h('div.progress',
          h('div.progress-head', phase, stopBtn),
          count,
          h('div.progress-track', fill),
          log),
        gridBox));

    const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);

    let done = 0;
    const total = plan?.probes ?? 0;
    const bump = (label) => {
      done += 1;
      count.replaceChildren(`${int(done)} `, h('em', `/ ${int(total)}`));
      fill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
      if (label) log.textContent = label;
    };

    try {
      const started = new Date();
      let out;

      if (state.tier === 'l0') {
        // L0 has two coarse steps rather than a probe stream; a counter that never moves
        // reads as a hang, so it goes away and the phase line does the reporting.
        count.remove();
        fill.parentElement.remove();
        out = await runL0({
          baseUrl: state.baseUrl, apiKey: state.apiKey, model: state.subject, protocol: PROTOCOL,
          onStep: ({ label }) => { phase.textContent = label; },
        });
      } else {
        const selection = await cellSelection();
        const grid = liveGrid({ cells: selection.cells.map((c) => c.cell), repsPerCell: selection.repsPerCell });
        gridBox.append(grid.el);

        if (state.tier === 'l2') {
          phase.textContent = '连通性预检（3 次）';
          const pre = await preflight(selection, cancel);
          if (!pre.ok) throw new Error(pre.message);
          log.textContent = `预检通过：${pre.valid}/3 拿到有效补全`;
        }

        const onProgress = ({ cell, ok, model }) => {
          grid.record(cell, ok);
          bump(model ? `正在采 ${model}` : null);
          if (done % 25 === 0) checkpoint(started).catch(() => {});
        };
        phase.textContent = state.tier === 'l1' ? '快筛采样' : '校准采样';

        const probeWrap = (p) => wrapProbe(p, cancel);
        out = state.tier === 'l1'
          ? await runL1({ baseUrl: state.baseUrl, apiKey: state.apiKey, model: state.subject,
                          control: state.control, protocol: PROTOCOL, probeWrap,
                          onProgress: wrap(onProgress, cancel) })
          : await runL2({ baseUrl: state.baseUrl, apiKey: state.apiKey, model: state.subject,
                          control: state.control, protocol: PROTOCOL, probeWrap,
                          sampleControl: state.sampleControl, concurrency: state.concurrency,
                          onProgress: wrap(onProgress, cancel) });
      }

      if (cancel.requested) { showSetup(h('div.banner.banner--info', '已停止，这次的结果没有保存。')); return; }

      const record = {
        id: runId(started), ts: started.toISOString(),
        host: new URL(state.baseUrl).host, baseUrl: state.baseUrl,
        model: state.subject, control: state.control, tier: state.tier, protocol: PROTOCOL,
        sampled_control: state.tier === 'l2' ? state.sampleControl : null,
        result: out.result, meta: out.meta, samples: out.samples,
      };
      await saveRun(record);
      await clearActive();
      await showReport(record);
    } catch (err) {
      console.error(err);
      showSetup(h('div.banner', h('strong', '这次跑没能完成'), h('p', { style: { margin: '0.35rem 0 0' } }, String(err?.message ?? err))));
    } finally {
      window.removeEventListener('beforeunload', guard);
    }

    async function cellSelection() {
      const list = await referencesFor(PROTOCOL);
      const rs = list.find((r) => r.model === state.subject);
      const rc = list.find((r) => r.model === state.control);
      return selectCells(rs, rc, { tier: state.tier });
    }

    /**
     * 🔴 Three probes before spending 870.
     *
     * A reasoning model that ignores `effort:none` burns the whole 16-token budget on
     * hidden reasoning and returns nothing; the fingerprint is then meaningless and the
     * gate would say so — after the full battery had been paid for. This project has
     * twice burned hundreds of probes on a run that could never have produced an answer.
     */
    async function preflight(selection, cancelFlag) {
      const { probe } = clientsFor({ baseUrl: state.baseUrl, apiKey: state.apiKey, protocol: PROTOCOL });
      const cell = selection.cells[0];
      const { samples } = await runBattery({
        probe: wrapProbe(probe, cancelFlag), model: state.subject,
        cells: [{ task_id: cell.task_id, lang: cell.lang, reps: 3 }],
        reps: 3, concurrency: 3, applyReasoningTrace: false, role: 'subject',
      });
      const valid = samples.filter((s) => s.state === 'valid').length;
      if (valid === 0) {
        const first = samples.find((s) => s.state !== 'valid');
        return { ok: false, valid, message:
          `预检 0/3 拿到有效补全（${first?.state ?? '未知'}${first?.error?.code ? ` / ${first.error.code}` : ''}）。` +
          `没有继续发那 ${int(total)} 次请求。常见原因：这个模型不接受 reasoning:{effort:"none"}，` +
          `于是把 16 个 token 的预算全烧在隐藏推理上，补全为空——那样指纹无从谈起。` };
      }
      return { ok: true, valid };
    }

    async function checkpoint(startedAt) {
      await saveActive({
        id: 'active', ts: startedAt.toISOString(), host: new URL(state.baseUrl).host,
        model: state.subject, tier: state.tier, done, total,
      });
    }

    function wrap(fn, cancelFlag) {
      return (p) => { if (!cancelFlag.requested) fn(p); };
    }
  }

  /* ── stage 3: report ────────────────────────────────────────────────── */

  async function showReport(record) {
    clear(stage);
    const prior = (await listRuns()).filter((r) => r.host === record.host && r.model === record.model);
    stage.append(await renderReport(record, {
      priorRuns: prior.length - 1,
      onAgain: () => showSetup(),
    }));
  }

  return root;
}

/**
 * Cancellation, at the only layer that can honour it: the probe. runBattery has no abort
 * signal, so a cancelled run returns a synthetic transport failure for every remaining
 * probe — the loop drains in milliseconds and the result is discarded, unsent.
 */
function wrapProbe(inner, cancel) {
  return async (args) => {
    if (cancel?.requested) {
      return {
        raw: '', error: { status: null, code: 'cancelled', message: 'cancelled' },
        http_status: null, latency_ms: 0, attempts: 0, usage: null,
        finish_reason: null, model_reported: null, reasoning_len: 0,
      };
    }
    return inner(args);
  };
}

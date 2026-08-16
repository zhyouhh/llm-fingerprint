// A 40-line element builder, so views read as structure instead of as 200 lines of
// createElement. No framework: the state here is a three-step wizard and a result object,
// which does not repay a reconciler.

/**
 * 🔴 The props argument is OPTIONAL and detected, not positional.
 *
 * `h('div', someElement)` and `h('span', '文字')` are the common shapes in these views, and
 * treating position 1 as props unconditionally silently DROPS that child — the header and
 * the whole hero vanished from the first render this way, with no error, because
 * Object.entries() of a DOM node is empty. Only a plain object counts as props.
 *
 * h('div.card#id', {onclick, dataset:{}, html}, ...children)
 * Children may be nodes, strings, numbers, arrays, or null/false/undefined (skipped).
 */
const isProps = (v) => v != null && typeof v === 'object'
  && !(v instanceof Node) && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function h(spec, ...args) {
  const props = isProps(args[0]) ? args.shift() : null;
  const children = args;
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const token of rest) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else el.id = token.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && typeof v !== 'boolean') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** SVG needs its own namespace; same optional-props rule otherwise. */
export function s(spec, ...args) {
  const props = isProps(args[0]) ? args.shift() : null;
  const children = args;
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const token of rest) if (token[0] === '.') el.classList.add(token.slice(1));
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/* ── formatting ─────────────────────────────────────────────────────────── */

export const fmt = (x, digits = 4) => (Number.isFinite(x) ? x.toFixed(digits) : '—');
export const pct = (x, digits = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—');
export const int = (x) => (Number.isFinite(x) ? x.toLocaleString('en-US') : '—');

export function duration(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))} 秒`;
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}

export function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const mins = (Date.now() - t) / 60_000;
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${Math.round(mins)} 分钟前`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} 小时前`;
  const days = Math.round(mins / 1440);
  if (days < 30) return `${days} 天前`;
  return new Date(t).toISOString().slice(0, 10);
}

/** The cell key `task|lang` split for display. */
export function cellParts(cell) {
  const [task, lang] = String(cell).split('|');
  return { task, lang };
}

export const LANG_LABEL = Object.freeze({ en: 'EN', zh: '中', ru: 'RU', ar: 'ع' });

/** Arabic answers need the paragraph direction flipped or the digits reorder. */
export function isRtl(lang) {
  return lang === 'ar';
}

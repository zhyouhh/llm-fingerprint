// VENDORED VERBATIM from PAMELA `stats/01-normalize.js` (MIT, Tomáš Bruckner).
// Source: https://doi.org/10.5281/zenodo.21278793
//
// ⚠️  DO NOT REWRITE THE LOGIC IN THIS FILE.
// Any deviation changes how answers are canonicalised, which silently makes our
// fingerprints incomparable with the published reference database. The only
// permitted change vs. upstream is the module wrapper: upstream reads `prompts`
// and `colorLex` from disk at module scope; here they are injected so the
// normaliser is a pure function. Function BODIES are byte-identical to upstream.
//
// `test/golden/g0-normalize.test.js` proves this extraction is faithful by
// re-normalising upstream's raw responses and diffing against upstream's own
// normalized.jsonl.

// ---------------------------------------------------------------- normalizers
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const ZH_DIGITS = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

// Chinese numerals 1-99 (e.g. 七=7, 十=10, 十七=17, 四十二=42).
function zhNumber(s) {
  const m = s.match(/^([零一二两三四五六七八九])?十?([零一二两三四五六七八九])?$/);
  if (!m || (!m[1] && !m[2] && !s.includes('十'))) return null;
  if (!s.includes('十')) return m[1] ? ZH_DIGITS[m[1]] : null;
  return (m[1] ? ZH_DIGITS[m[1]] : 1) * 10 + (m[2] ? ZH_DIGITS[m[2]] : 0);
}

// Strip wrapping quotes/brackets/punctuation, collapse whitespace, NFC.
function basicClean(raw) {
  return raw.normalize('NFC')
    .replace(/[«»"“”„'’‘`().,!?。！？、：:;؛؟\[\]{}*_#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REFUSAL_RE = /(i can.?t|i cannot|i'm sorry|as an ai|не могу|извин|抱歉|无法|لا أستطيع|عذراً|آسف)/i;

// Language-specific binary pairs for coin-flip → canonical h/t.
const COIN = {
  en: { heads: 'h', tails: 't' },
  ru: { 'орёл': 'h', 'орел': 'h', 'решка': 't' },
  zh: { '正面': 'h', '正': 'h', '反面': 't', '反': 't' },
  ar: { 'صورة': 'h', 'كتابة': 't' },
};

/**
 * Build the upstream `normalize(rec)` function with its two module-scope
 * dependencies injected.
 *
 * @param {object} prompts  parsed vendor/pamela/config/prompts.json
 * @param {object} colorLex parsed vendor/pamela/stats/color-lexicon.json
 * @returns {(rec: object) => {normalized: string|null, answer_class: string, color_canon: string|null}}
 */
export function createNormalizer(prompts, colorLex) {
  const taskById = Object.fromEntries(prompts.tasks.map((t) => [t.id, t]));

  return function normalize(rec) {
    const task = taskById[rec.task_id];
    const out = { normalized: null, answer_class: 'invalid', color_canon: null };
    if (!task) return out;
    if (rec.raw == null || !rec.raw.trim()) return { ...out, answer_class: 'empty' };
    if (REFUSAL_RE.test(rec.raw)) return { ...out, answer_class: 'refusal' };

    let s = basicClean(rec.raw);
    if (!s) return { ...out, answer_class: 'empty' };
    s = s.replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]); // Arabic-Indic → Latin digits

    if (task.normalize_as === 'integer') {
      let n = null;
      const m = s.match(/-?\d+/);
      if (m) n = parseInt(m[0], 10);
      else if (rec.lang === 'zh') n = zhNumber(s);
      if (n == null) return out;
      const range = task.answer_space.match(/(\d+)-(\d+)/);
      const inRange = !range || (n >= +range[1] && n <= +range[2]);
      return { ...out, normalized: String(n), answer_class: inRange ? 'valid' : 'invalid' };
    }

    if (task.normalize_as === 'binary') {
      const w = s.toLowerCase().split(' ')[0];
      const c = COIN[rec.lang]?.[w];
      return c ? { ...out, normalized: c, answer_class: 'valid' } : out;
    }

    // word / grapheme: first whitespace-token, lowercased (no-op for zh/ar scripts)
    const words = s.toLowerCase().split(' ');
    if (task.normalize_as === 'word' && words.length > 3) return out; // whole sentence ⇒ off-format
    const w = words[0];
    if (!w) return { ...out, answer_class: 'empty' };
    if (task.normalize_as === 'grapheme' && [...w].length > 1 && rec.lang !== 'zh') {
      // "letter A" style answers: take the single-char token if any
      const single = words.find((x) => [...x].length === 1);
      if (!single) return out;
      return { ...out, normalized: single, answer_class: 'valid' };
    }
    const res = { ...out, normalized: w, answer_class: 'valid' };
    if (task.category === 'color') res.color_canon = colorLex.map[rec.lang]?.[w] ?? null;
    return res;
  };
}

/**
 * Upstream's reasoning-trace screen (01-normalize.js "Pre-pass").
 *
 * Some providers emit a hidden reasoning trace despite `reasoning:{enabled:false}`.
 * Such responses are not single-pass samples and must not enter fingerprints.
 * Derives which (model, provider) pairs emit traces from records that carry
 * `reasoning_len`, then applies that verdict to older field-less records.
 *
 * @param {Iterable<object>} records raw response records
 * @returns {Set<string>} keys of the form `${model}@${provider}`
 */
export function detectReasoningPairs(records) {
  const pairSeen = {}; // model@provider -> { n, rsn }
  for (const rec of records) {
    if (rec.error || !('reasoning_len' in rec)) continue;
    const s = (pairSeen[`${rec.model}@${rec.provider}`] ??= { n: 0, rsn: 0 });
    s.n++; if (rec.reasoning_len > 0) s.rsn++;
  }
  return new Set(
    Object.entries(pairSeen).filter(([, s]) => s.n >= 20 && s.rsn / s.n >= 0.3).map(([k]) => k)
  );
}

/** True if this record shows a reasoning trace (direct field, or inferred pair). */
export function emittedTrace(rec, reasoningPairs) {
  return (rec.reasoning_len ?? 0) > 0
    || (!('reasoning_len' in rec) && reasoningPairs.has(`${rec.model}@${rec.provider}`));
}

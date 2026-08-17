// The fingerprint itself, shown as what it actually is: the words a model keeps saying.
//
// Every other way of presenting this — a distance number, a bar chart, a matrix — asks the
// reader to trust an abstraction. The answers do not: gpt-5.6-sol replies زرافة to
// "name a random animal" in Arabic and gpt-5.6-luna replies فيل, and once you have seen
// those two cells swap you know what a fingerprint is without being told.
//
// So this grid is the explanation, the hero, and the live progress display, all from the
// same component.

import { h, pct, cellParts, LANG_LABEL, isRtl } from '../ui/dom.js';
import { comparableCells, REFERENCE_MIN_N } from '../../../src/stats/noise.js';

/** The winning answer in a cell, and how often it won. */
export function modeOf(dist) {
  let best = null;
  let p = 0;
  for (const [answer, prob] of Object.entries(dist ?? {})) {
    if (prob > p) { p = prob; best = answer; }
  }
  return { answer: best, p };
}

/**
 * Rank cells by how much they disagree ACROSS the given references — the cells worth
 * putting in a hero are the ones that carry information, and which those are is a
 * property of the model set, not something to hard-code (决策 #4, same reasoning as
 * selectCells).
 *
 * @returns {string[]} cell keys, most discriminating first
 */
export function discriminatingCells(refs) {
  // 🔴 The same reference sample bar selection, the matrix and the verdict all apply — and
  // it has to be an INTERSECTION over the models being shown, not a per-model filter whose
  // results are then unioned. The grid draws every model's answer in every listed cell, so
  // a cell that only A measured once still gets drawn for A the moment B and C carry it
  // properly: the offending answer reappears on screen through a different door, and it is
  // precisely the answer no decision layer would use.
  const usable = refs.map((ref) => comparableCells(ref, REFERENCE_MIN_N));
  const shownEverywhere = (cell) => usable.every((set) => set.has(cell));
  const counts = new Map();
  for (const ref of refs) {
    for (const [cell, dist] of Object.entries(ref.fingerprint ?? {})) {
      if (!shownEverywhere(cell)) continue;
      const { answer } = modeOf(dist);
      if (answer == null) continue;
      if (!counts.has(cell)) counts.set(cell, new Set());
      counts.get(cell).add(answer);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1].size - a[1].size) || a[0].localeCompare(b[0]))
    .map(([cell]) => cell);
}

/**
 * A display set that tells the truth about a fingerprint: mostly cells that discriminate,
 * plus a few that never move.
 *
 * Showing only the top-ranked cells makes every model switch repaint almost the whole
 * grid, which reads as "these models are unrelated" — the opposite of what the data says.
 * The real shape is that a substitution changes a handful of cells out of forty and agrees
 * everywhere else, and the dead cells are why the battery has to be selected per model
 * pair rather than fixed (决策 #4).
 */
export function displayCells(refs, { total = 16, stable = 4 } = {}) {
  const ranked = discriminatingCells(refs);
  if (ranked.length <= total) return ranked;
  const live = ranked.slice(0, total - stable);
  const tail = ranked.slice(-stable).filter((c) => !live.includes(c));
  return [...live, ...tail];
}

/**
 * @param {{cells: string[], refs: object[], model: string, showProbability?: boolean}} opts
 * @returns {{el: HTMLElement, setModel: (model: string) => string[]}}
 *   setModel returns the cells that changed, so a caller can narrate the diff.
 */
export function fingerprintGrid({ cells, refs, model, showProbability = true }) {
  const byModel = new Map(refs.map((r) => [r.model, r]));
  const tiles = new Map();
  let current = model;

  const el = h('div.fp-grid', { role: 'table', 'aria-label': '单 token 答案指纹' });

  for (const cell of cells) {
    const { task, lang } = cellParts(cell);
    const answerEl = h('div.fp-answer', { dir: isRtl(lang) ? 'rtl' : 'ltr' });
    const probEl = showProbability ? h('div.fp-prob') : null;
    const tile = h('div.fp-tile', { role: 'cell', title: cell },
      h('div.fp-meta',
        h('span.fp-task', task.replace(/-random$/, '')),
        h('span.fp-lang', LANG_LABEL[lang] ?? lang)),
      answerEl,
      probEl);
    tiles.set(cell, { tile, answerEl, probEl });
    el.append(tile);
  }

  paint(current, false);

  function paint(nextModel, animate) {
    const ref = byModel.get(nextModel);
    const changed = [];
    for (const [cell, { tile, answerEl, probEl }] of tiles) {
      const { answer, p } = modeOf(ref?.fingerprint?.[cell]);
      const shown = answer ?? '—';
      const differs = animate && answerEl.textContent !== shown;
      if (differs) changed.push(cell);

      const write = () => {
        answerEl.textContent = shown;
        if (probEl) probEl.textContent = answer ? pct(p) : '';
        // A cell where one answer wins outright looks different from one that is split,
        // and that difference is load-bearing: a deterministic cell punishes a single
        // stray answer hard (JSD 0.108 for one outlier in five).
        tile.classList.toggle('is-certain', p >= 0.9);
      };

      if (differs) {
        tile.classList.add('is-flipping');
        setTimeout(write, 160);
        setTimeout(() => {
          tile.classList.remove('is-flipping');
          tile.classList.add('is-changed');
        }, 320);
      } else {
        write();
        if (animate) tile.classList.remove('is-changed');
      }
    }
    current = nextModel;
    return changed;
  }

  return {
    el,
    setModel: (next) => paint(next, !window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    get model() { return current; },
  };
}

/**
 * The same grid, driven by a run in progress: cells fill in as probes land.
 *
 * @returns {{el, record: (cell: string, ok: boolean) => void, reset: () => void}}
 */
export function liveGrid({ cells, repsPerCell }) {
  const tiles = new Map();
  const el = h('div.fp-grid.is-live', { 'aria-label': '采样进度' });

  for (const cell of cells) {
    const { task, lang } = cellParts(cell);
    const pips = h('div.fp-pips');
    for (let i = 0; i < repsPerCell; i += 1) pips.append(h('i.fp-pip'));
    const tile = h('div.fp-tile.fp-tile--live', { title: cell },
      h('div.fp-meta',
        h('span.fp-task', task.replace(/-random$/, '')),
        h('span.fp-lang', LANG_LABEL[lang] ?? lang)),
      pips);
    tiles.set(cell, { tile, pips, filled: 0 });
    el.append(tile);
  }

  return {
    el,
    record(cell, ok) {
      const t = tiles.get(cell);
      if (!t) return;
      const pip = t.pips.children[t.filled];
      if (pip) pip.classList.add(ok ? 'is-on' : 'is-fail');
      t.filled = Math.min(t.filled + 1, repsPerCell);
      if (t.filled >= repsPerCell) t.tile.classList.add('is-done');
    },
    reset() {
      for (const t of tiles.values()) {
        t.filled = 0;
        t.tile.classList.remove('is-done');
        for (const pip of t.pips.children) pip.classList.remove('is-on', 'is-fail');
      }
    },
  };
}

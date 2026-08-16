// The model map.
//
// 🔴 The cells encode SEPARATION — distance ÷ the noisier of the two models' floors — not
// raw distance. Raw distance is unreadable on its own: 0.14 between gpt-5.3-codex and
// gpt-5.4 sounds close until you know their floors are 0.031 and 0.027, making it 4.6
// floors apart. Different models have very different floors (terra 0.019, nano 0.059), so
// one absolute colour scale would be wrong in both directions at once.
//
// 🔴 The diagonal is each model's own noise floor, not zero. Without it a reader has no
// scale at all: "sol vs luna = 0.18" is enormous or trivial and nothing on screen says
// which. With it, the row's own diagonal IS the scale.
//
// Bright = few floors apart = the alarming end. That inverts the usual "big value, dark
// colour" convention on purpose, because the finding a reader is hunting for is a pair the
// method CANNOT tell apart. The legend says so in words.

import { h, fmt } from '../ui/dom.js';
import { classifyPair } from '../../../src/layers/model-matrix.js';

/**
 * Separation → band index. Bands, not a continuous scale: the read is categorical
 * ("inside the noise", "a couple of floors", "unmistakable"), and a smooth ramp invites
 * comparisons between two cells that the measurement cannot support.
 *
 * @returns {number} 0 (indistinguishable) … 5 (far apart), or -1 for no value
 */
export const BAND_EDGES = Object.freeze([1, 2, 5, 8, 12]);

export function band(separation) {
  if (!Number.isFinite(separation)) return -1;
  const i = BAND_EDGES.findIndex((edge) => separation <= edge);
  return i === -1 ? BAND_EDGES.length : i;
}

export const rampStep = (separation) => {
  const b = band(separation);
  return b < 0 ? 'var(--surface-2)' : `var(--ramp-${b})`;
};

const CLASS_LABEL = Object.freeze({
  indistinguishable: '分不出来',
  near: '接近',
  distinct: '明确不同',
  'no shared cells': '无共同格子',
  unknown: '未知',
});

/**
 * @param {{models, matrix, floors, cells}} m  the precomputed map for one protocol
 * @param {{onSelect?: (a: string, b: string) => void, highlight?: string}} [opts]
 */
export function heatmap(m, { highlight = null } = {}) {
  const n = m.models.length;
  const readout = h('div.hm-readout', h('span.hm-readout-hint', '把指针放到格子上看这一对的数'));

  const grid = h('div.hm-grid', {
    style: { gridTemplateColumns: `var(--hm-label) repeat(${n}, minmax(0, 1fr))` },
  });

  grid.append(h('div.hm-corner'));
  for (const model of m.models) {
    grid.append(h('div.hm-col-label', { class: model === highlight ? 'is-highlight' : '' },
      h('span', short(model))));
  }

  for (let i = 0; i < n; i += 1) {
    grid.append(h('div.hm-row-label', { class: m.models[i] === highlight ? 'is-highlight' : '' },
      short(m.models[i])));
    for (let j = 0; j < n; j += 1) {
      const distance = m.matrix[i][j];
      const floorA = m.floors[i];
      const floorB = m.floors[j];
      const bar = Math.max(floorA, floorB);
      const isDiagonal = i === j;
      // On the diagonal the "distance" IS the floor, so separation is 1 by definition —
      // which is the honest statement: a model is exactly one noise floor from itself.
      const separation = isDiagonal ? 1 : distance / bar;
      const klass = isDiagonal ? 'self' : classifyPair(distance, floorA, floorB);

      // 🔴 The diagonal is deliberately NOT on the ramp. It is a model against itself, so
      // its separation is 1 by definition, and painting it with the ≤1 step — the alarming
      // end — made the whole diagonal glow like ten findings. It is the reader's yardstick,
      // not a result, so it gets its own neutral treatment and shows the floor value
      // itself rather than a ratio.
      const cell = h('button.hm-cell', {
        type: 'button',
        style: isDiagonal ? null : { background: rampStep(separation) },
        dataset: {
          klass, diagonal: String(isDiagonal),
          band: isDiagonal ? 'self' : String(band(separation)),
        },
        'aria-label': isDiagonal
          ? `${m.models[i]} 自身的噪声地板 ${fmt(distance)}`
          : `${m.models[i]} 对 ${m.models[j]}：JSD ${fmt(distance)}，${fmt(separation, 1)} 倍地板`,
        onmouseenter: () => showPair(i, j),
        onfocus: () => showPair(i, j),
      },
        // The number rides on the cell, so the map is readable without hovering and in a
        // screenshot. Colour is the index; the digits are the data.
        h('span.hm-num', isDiagonal ? fmt(distance, 3) : fmt(separation, 1)));

      // Secondary encoding for the one class that matters — never colour alone.
      if (klass === 'indistinguishable') cell.append(h('span.hm-flag', '!'));
      grid.append(cell);
    }
  }

  function showPair(i, j) {
    const distance = m.matrix[i][j];
    const bar = Math.max(m.floors[i], m.floors[j]);
    const klass = i === j ? 'self' : classifyPair(distance, m.floors[i], m.floors[j]);
    readout.replaceChildren(
      h('span.hm-pair', i === j ? `${m.models[i]} 与自己` : `${m.models[i]} ↔ ${m.models[j]}`),
      h('span.hm-stat', h('em', 'JSD'), fmt(distance)),
      h('span.hm-stat', h('em', '地板'), fmt(bar)),
      i === j ? null : h('span.hm-stat', h('em', '分离度'), `${fmt(distance / bar, 1)}×`),
      h('span.hm-class', { dataset: { klass } }, i === j ? '自身噪声' : (CLASS_LABEL[klass] ?? klass)));
  }

  return h('div.hm', grid, readout, legend());
}

function legend() {
  // 🔴 The first two edges are semantic and fixed — 1× is "inside the noise" and 2× is the
  // separation the identification layer demands before it will name a model. The rest are
  // spread over where the real numbers actually live (the ten official references span
  // 4.6× to 13.8×); an evenly-spaced ramp left three of six steps permanently empty and
  // rendered the map as one flat colour.
  const steps = [
    ['var(--ramp-0)', '≤1×'],
    ['var(--ramp-1)', '2×'],
    ['var(--ramp-2)', '5×'],
    ['var(--ramp-3)', '8×'],
    ['var(--ramp-4)', '12×'],
    ['var(--ramp-5)', '更远'],
  ];
  // 🔴 No "brighter means X" in the wording. The ramp inverts between themes — the
  // alarming end is the light one on a dark ground and the dark one on a light ground —
  // so a sentence naming a direction is wrong in one of the two. The swatches carry the
  // direction; the words carry the meaning.
  return h('div.hm-legend',
    h('span.hm-legend-title', '格子 = 这一对相隔几个噪声地板'),
    h('div.hm-legend-ramp',
      h('span.hm-legend-end', '分不出来'),
      ...steps.map(([color, tick]) => h('div.hm-legend-step',
        h('i', { style: { background: color } }),
        h('span', tick))),
      h('span.hm-legend-end', '明确不同')),
    h('span.hm-legend-note',
      '对角线单独一种底色：那是各模型自己的噪声地板——读这张表的尺度，不是一个结果'));
}

/** `gpt-5.6-sol` → `5.6-sol`; the shared prefix is noise in a 10×10 grid. */
export function short(model) {
  return String(model).replace(/^gpt-/, '');
}

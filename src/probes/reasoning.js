// Reasoning probes: freshly generated instances whose answers we compute exactly.
//
// Why generated rather than a fixed list: a static bank is a one-time secret. hvoy.ai
// ships the same six questions to every endpoint it tests — by their own count, over a
// million times — so any relay operator can read them out of their access log and
// hardcode the answers. A generator with an exact solver has no such shelf life: every
// run is a new instance, and correctness is checked against our own computation rather
// than a stored key.
//
// Both families below are ADAPTIVE ADVERSARIAL problems: the solver plays worst case
// against an opponent who chooses the outcome of each draw. That structure is what makes
// them sensitive to reasoning depth — a shallow pass produces a plausible pigeonhole-ish
// number that is simply wrong.

/** Deterministic PRNG so a seed reproduces an instance exactly. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const pick = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ---------------------------------------------------------------- family 1: pigeonhole
/**
 * "Minimum draws to guarantee k items of a single colour."
 *
 * Closed form: the adversary hands out as many as possible while keeping every colour
 * below k, i.e. sum(min(count_i, k-1)); one more draw forces a k-th.
 */
export function guaranteeSameColour({ counts, k }) {
  if (!counts.some((c) => c >= k)) return null; // unachievable — never emit these
  return counts.reduce((s, c) => s + Math.min(c, k - 1), 0) + 1;
}

export function genPigeonhole(seed) {
  const r = rng(seed);
  const names = ['red', 'blue', 'green', 'yellow', 'purple'];
  const n = pick(r, 3, 4);
  const colours = names.slice(0, n);
  const counts = colours.map(() => pick(r, 3, 11));
  const k = pick(r, 3, Math.min(4, Math.max(...counts)));
  const answer = guaranteeSameColour({ counts, k });
  if (answer === null) return null;
  const list = colours.map((c, i) => `${counts[i]} ${c}`).join(', ');
  return {
    family: 'pigeonhole', seed, answer,
    prompt: `A bag contains ${list} balls. Drawing without looking, what is the minimum number of draws needed to guarantee ${k} balls of the same colour? Answer with only an integer.`,
  };
}

// ------------------------------------------------- family 2: adaptive two-attribute pair
/**
 * Exact minimax for the "candy" problem: items have a visible attribute (shape) you may
 * choose and a hidden attribute (flavour) revealed only after drawing. You adapt after
 * each reveal; the flavour you get is chosen adversarially from what remains of that
 * shape. Goal: collect one of several target pairs.
 *
 * value(state) = 1 + min over shapes  ( max over flavours  value(next) )
 * with 0 at a satisfied goal and Infinity when the bag cannot satisfy it at all.
 *
 * @param {number[][]} grid        grid[shape][flavour] = remaining count
 * @param {number[][][]} targets   list of goals; each goal is a list of [shape, flavour] pairs, all required
 * @returns {number|null}          worst-case draws, or null if not guaranteeable
 */
export function adaptivePairMinimax(grid, targets) {
  const S = grid.length, F = grid[0].length;
  const bit = (s, f) => 1 << (s * F + f);
  const goalMasks = targets.map((g) => g.reduce((m, [s, f]) => m | bit(s, f), 0));
  const memo = new Map();

  const solve = (counts, held) => {
    if (goalMasks.some((g) => (held & g) === g)) return 0;
    const key = counts.join(',') + '|' + held;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    let best = Infinity;
    for (let s = 0; s < S; s++) {
      let rowTotal = 0;
      for (let f = 0; f < F; f++) rowTotal += counts[s * F + f];
      if (rowTotal === 0) continue;
      // adversary picks the worst flavour available in this shape
      let worst = -Infinity;
      for (let f = 0; f < F; f++) {
        if (counts[s * F + f] === 0) continue;
        const next = counts.slice();
        next[s * F + f]--;
        const v = solve(next, held | bit(s, f));
        if (v > worst) worst = v;
        if (worst === Infinity) break;
      }
      if (worst + 1 < best) best = worst + 1;
    }
    memo.set(key, best);
    return best;
  };

  const flat = grid.flat();
  const v = solve(flat, 0);
  return Number.isFinite(v) ? v : null;
}

export function genAdaptivePair(seed) {
  const r = rng(seed);
  const shapes = ['diamond', 'triangle'];
  const flavours = ['watermelon', 'peach', 'grape'];
  // Keep totals modest: the minimax is exponential in the number of items.
  const grid = shapes.map(() => flavours.map(() => pick(r, 1, 6)));
  // Two crossed goals, the shape that makes the naive pigeonhole answer wrong.
  const targets = [
    [[0, 0], [1, 1]],
    [[0, 1], [1, 0]],
  ];
  const answer = adaptivePairMinimax(grid, targets);
  if (answer === null) return null;

  const header = `shape | ${flavours.join(' | ')}`;
  const rows = shapes.map((s, i) => `${s} | ${grid[i].join(' | ')}`).join('\n');
  return {
    family: 'adaptive-pair', seed, answer, grid,
    prompt: `An opaque bag contains candies with three flavors and two shapes:
${header}
${rows}
You may choose the shape of every candy before drawing it, but cannot feel its flavor. After each draw, the flavor is revealed, and you may adapt the shape chosen for the next draw. What is the minimum number of candies needed to guarantee either (${shapes[0]} ${flavours[0]} + ${shapes[1]} ${flavours[1]}) or (${shapes[0]} ${flavours[1]} + ${shapes[1]} ${flavours[0]})? Return only the minimum number.`,
  };
}

/**
 * Generate n solvable instances across both families.
 * @param {number} n
 * @param {number} seed0
 */
export function generate(n, seed0 = 1) {
  const out = [];
  for (let i = 0; out.length < n && i < n * 20; i++) {
    const seed = seed0 + i;
    const g = (i % 2 === 0) ? genAdaptivePair(seed) : genPigeonhole(seed);
    if (g) out.push(g);
  }
  return out;
}

/** Extract the model's integer answer; null when it did not emit one. */
export function parseInteger(text) {
  const m = String(text ?? '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

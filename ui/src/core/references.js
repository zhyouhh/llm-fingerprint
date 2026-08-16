// Genuine references, as the browser sees them.
//
// The shipped form drops `samples` (95% of the file) and keeps `answers`: each cell's
// valid answers in collection order. `rehydrate` puts back exactly the shape the
// statistics read.
//
// 🔴 This is the ONLY implementation of that reconstruction. ui/scripts/build-data.js
// imports it rather than owning a second copy, and then proves — for every ordered pair
// of references — that selectCells / noiseFloor / calibrateL1Thresholds / evaluateL1 /
// evaluateL2 / modelMatrix come out bit-identical against the full files. If this
// function and that check ever disagree, the build fails instead of shipping numbers
// that are quietly a little different.

/**
 * @param {object} lean a slim reference from public/data/references.json
 * @returns {object} the same object with `samples` reconstructed
 */
export function rehydrate(lean) {
  const samples = [];
  for (const [cell, list] of Object.entries(lean.answers ?? {})) {
    for (const normalized of list) samples.push({ cell, normalized, answer_class: 'valid' });
  }
  return { ...lean, samples };
}

let cache = null;

/** @returns {Promise<Record<string, object[]>>} protocol → rehydrated references */
export async function loadReferences() {
  if (!cache) {
    const res = await fetch('/data/references.json');
    if (!res.ok) throw new Error(`could not load the reference library (${res.status})`);
    const raw = await res.json();
    cache = Object.fromEntries(Object.entries(raw).map(([p, list]) => [p, list.map(rehydrate)]));
  }
  return cache;
}

let matrixCache = null;

/** Precomputed pairwise distances + per-model noise floors, one entry per protocol. */
export async function loadMatrix() {
  if (!matrixCache) {
    const res = await fetch('/data/model-matrix.json');
    if (!res.ok) throw new Error(`could not load the model map (${res.status})`);
    matrixCache = await res.json();
  }
  return matrixCache;
}

export async function referencesFor(protocol) {
  const all = await loadReferences();
  return all[protocol] ?? [];
}

export async function referenceFor(model, protocol) {
  return (await referencesFor(protocol)).find((r) => r.model === model) ?? null;
}

/** Models we hold a genuine reference for, on this wire. */
export async function referenceModels(protocol) {
  return (await referencesFor(protocol)).map((r) => r.model);
}

/** A reference collected this long ago stops being evidence about today's weights. */
export const STALE_DAYS = 90;

export function ageInDays(collectedUtc, now = Date.now()) {
  if (!collectedUtc) return null;
  const t = Date.parse(collectedUtc);
  return Number.isFinite(t) ? (now - t) / 86_400_000 : null;
}

export function isStale(collectedUtc, now = Date.now()) {
  const age = ageInDays(collectedUtc, now);
  return age != null && age > STALE_DAYS;
}

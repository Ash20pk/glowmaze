// Tactics: the geometry the language model is bad at, computed in code so the model only has to judge.
//
//  - Junctions (tiles with 3+ exits) get short names like "J14" the model can reason about.
//  - Line of sight: a hunter sees the player down a straight, unbroken corridor, or right next to them.
//  - Escape routes: the junctions the player can reach next, and who on the team gets there first.
//  - Search candidates: when the player is hidden, the junctions they could have reached since they
//    were last seen, ranked by how likely they are and whether anyone has looked there since.

import { COLS, ROWS, FLOOR_TILES, DIRS, isFloor, neighbors } from "./shared.js";

const idx = (c, r) => r * COLS + c;

export const JUNCTIONS = FLOOR_TILES.filter(([c, r]) => neighbors(c, r).length >= 3).map((at, i) => ({ id: `J${i + 1}`, at }));
const JUNCTION_AT = new Map(JUNCTIONS.map((j) => [idx(...j.at), j]));

/** BFS from a tile: distance to every tile, plus which direction the first step went. */
export function flood(from) {
  const dist = new Int16Array(COLS * ROWS).fill(-1);
  const first = new Array(COLS * ROWS).fill(null);
  dist[idx(...from)] = 0;
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    for (const [d, [dc, dr]] of Object.entries(DIRS)) {
      const n = [c + dc, r + dr];
      if (!isFloor(...n) || dist[idx(...n)] !== -1) continue;
      dist[idx(...n)] = dist[idx(c, r)] + 1;
      first[idx(...n)] = i === 0 ? d : first[idx(c, r)];
      q.push(n);
    }
  }
  return { dist: (t) => dist[idx(...t)], first: (t) => first[idx(...t)], reached: q.length };
}

/** Straight, unbroken corridor between a and b (same row or column), or adjacent (incl. diagonal). */
export function canSee(a, b) {
  if (Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1) return true;
  if (a[0] === b[0]) {
    const [lo, hi] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]];
    for (let r = lo; r <= hi; r++) if (!isFloor(a[0], r)) return false;
    return true;
  }
  if (a[1] === b[1]) {
    const [lo, hi] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]];
    for (let c = lo; c <= hi; c++) if (!isFloor(c, a[1])) return false;
    return true;
  }
  return false;
}

/** For every floor tile, the junctions visible from it (used to track which areas were searched). */
export const VISIBLE_JUNCTIONS = new Map();
for (const t of FLOOR_TILES) {
  const seen = [];
  if (JUNCTION_AT.has(idx(...t))) seen.push(JUNCTION_AT.get(idx(...t)));
  for (const [dc, dr] of Object.values(DIRS)) {
    let [c, r] = [t[0] + dc, t[1] + dr];
    while (isFloor(c, r)) {
      if (JUNCTION_AT.has(idx(c, r))) seen.push(JUNCTION_AT.get(idx(c, r)));
      c += dc;
      r += dr;
    }
  }
  VISIBLE_JUNCTIONS.set(idx(...t), seen);
}
export const junctionsVisibleFrom = (t) => VISIBLE_JUNCTIONS.get(idx(...t)) || [];

/** The first junction down each branch leading out of tile t (usually 2–4 of them). */
export function nextJunctions(t) {
  const seen = new Set([idx(...t)]);
  const out = [];
  const q = [[t, 0, null]];
  for (let i = 0; i < q.length; i++) {
    const [cur, d, firstDir] = q[i];
    for (const [dir, [dc, dr]] of Object.entries(DIRS)) {
      const n = [cur[0] + dc, cur[1] + dr];
      if (!isFloor(...n) || seen.has(idx(...n))) continue;
      seen.add(idx(...n));
      const fd = firstDir ?? dir;
      const j = JUNCTION_AT.get(idx(...n));
      if (j) out.push({ junction: j, dist: d + 1, firstDir: fd });
      else q.push([n, d + 1, fd]);
    }
  }
  return out;
}

/**
 * Where a hidden player could be. Junctions reachable from the last sighting within the distance
 * the player could have covered, scored by: along their last heading, near the edge of that range
 * (they were probably still running), and not looked at by any hunter since the sighting.
 */
export function searchCandidates(lastSeen, maxTiles, checkedAt, seenAtTime, limit = 5) {
  const f = flood(lastSeen.at);
  const out = [];
  for (const j of JUNCTIONS) {
    const d = f.dist(j.at);
    if (d < 0 || d > maxTiles) continue;
    const along = lastSeen.heading != null && f.first(j.at) === lastSeen.heading;
    const unchecked = (checkedAt.get(j.id) ?? -Infinity) < seenAtTime;
    const frontier = 1 - Math.abs(d - Math.min(maxTiles, 18)) / Math.max(maxTiles, 1);
    out.push({ j, d, along, unchecked, score: (along ? 2 : 0) + (unchecked ? 1.5 : 0) + frontier });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

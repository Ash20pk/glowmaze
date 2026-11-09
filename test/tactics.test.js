import { test } from "node:test";
import assert from "node:assert/strict";
import { MAZE, COLS, ROWS, FLOOR_TILES, isOpen, isFloor, tempWalls, path, nearestFloor } from "../public/shared.js";
import { JUNCTIONS, canSee, flood, nextJunctions, searchCandidates } from "../public/tactics.js";

test("maze is rectangular, walled in, fully connected, with no dead ends", () => {
  assert.ok(MAZE.every((r) => r.length === COLS));
  for (let c = 0; c < COLS; c++) assert.ok(!isOpen(c, 0) && !isOpen(c, ROWS - 1));
  assert.equal(flood(FLOOR_TILES[0]).reached, FLOOR_TILES.length);
  for (const [c, r] of FLOOR_TILES) {
    const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => isOpen(c + dc, r + dr)).length;
    assert.ok(exits >= 2, `dead end at ${c},${r}`);
  }
});

test("junctions are named J1..Jn and all have 3+ exits", () => {
  assert.equal(JUNCTIONS[0].id, "J1");
  assert.ok(JUNCTIONS.length > 20);
});

test("line of sight stops at walls", () => {
  assert.ok(canSee([1, 1], [35, 1])); // the open top row
  assert.ok(!canSee([1, 1], [1, 21])); // walls in column 1
  assert.ok(canSee([5, 5], [6, 6])); // adjacent, diagonal
});

test("temporary walls block movement, paths and sight", () => {
  const t = [18, 1];
  assert.ok(isFloor(...t));
  tempWalls.add(t[1] * COLS + t[0]);
  try {
    assert.ok(!isFloor(...t));
    assert.ok(!canSee([1, 1], [35, 1]));
    assert.ok(!path([17, 1], [19, 1]).some(([c, r]) => c === 18 && r === 1));
  } finally {
    tempWalls.clear();
  }
});

test("escapes lead to junctions; search candidates stay within range", () => {
  const escapes = nextJunctions([9, 17]);
  assert.ok(escapes.length >= 1);
  for (const e of escapes) assert.ok(e.dist > 0);
  const cands = searchCandidates({ at: [18, 11], heading: "left" }, 6, new Map(), 0);
  const f = flood([18, 11]);
  for (const c of cands) assert.ok(f.dist(c.j.at) <= 6);
});

test("nearestFloor snaps walls and garbage to a floor tile", () => {
  assert.ok(isOpen(...nearestFloor(0, 0)));
  assert.ok(isOpen(...nearestFloor(NaN, undefined)));
});

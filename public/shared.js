// Shared by the browser game and the server: the maze, the hunters, and grid helpers.

export const MAZE = [
"#####################################",
  "#...................................#",
  "#.###.#######.#.#####.#.#######.###.#",
  "#...#.......#.....#.....#.......#...#",
  "#.#.#######.###.#.#.#.###.#######.#.#",
  "#...........#...#.#.#...#...........#",
  "###.###.#####.#.#.#.#.#.#####.###.###",
  "#...#.....#...#.......#...#.....#...#",
  "#.###.###.#.#.###.#.###.#.#.###.###.#",
  "#...#...#.#.#...#...#...#.#.#...#...#",
  "###.###.#.#.###.#####.###.#.#.###.###",
  "#...................................#",
  "#.#.#.###.#.###.#####.###.#.###.#.#.#",
  "#...#.....#...#...#...#...#.....#...#",
  "#.###########.###.#.###.###########.#",
  "#.#.........#.....#.....#.........#.#",
  "#.#.#######.#############.#######.#.#",
  "#...........#...........#...........#",
  "###.#.#.#####.#.#####.#.#####.#.#.###",
  "#.....#.........#...#.........#.....#",
  "#.#########.#####.#.#####.#########.#",
  "#...................................#",
  "#####################################",
];

export const COLS = MAZE[0].length;
export const ROWS = MAZE.length;
export const PLAYER_SPAWN = [18, 21];
export const PULSE_TILES = [[1, 1], [35, 1], [1, 11], [35, 11], [1, 21], [35, 21]];

export const HUNTERS = [
  {
    id: "rook",
    name: "Rook",
    color: "#ff4d6d",
    spawn: [16, 11],
    persona:
      "You are Rook, the bruiser. Pressure the player directly and never let them rest. " +
      "Aim a couple of tiles ahead of the player along their heading rather than at their current tile.",
  },
  {
    id: "vex",
    name: "Vex",
    color: "#ffb02e",
    spawn: [20, 11],
    persona:
      "You are Vex, the interceptor. Predict where the player is going and get there first. " +
      "Pick the junction or corridor the player will reach in 4 to 8 tiles and cut it off.",
  },
  {
    id: "moth",
    name: "Moth",
    color: "#3dd6ff",
    spawn: [18, 11],
    persona:
      "You are Moth, the guard. The player must collect every spark to win. " +
      "Stand watch near the area with the most sparks left, or the cluster the player is heading for.",
  },
  {
    id: "grim",
    name: "Grim",
    color: "#b388ff",
    spawn: [14, 11],
    persona:
      "You are Grim, the herder. Stay a few tiles behind the player on the side away from your teammates, " +
      "so the player is pushed toward the others. Close in only when a teammate blocks the escape route.",
  },
  {
    id: "pip",
    name: "Pip",
    color: "#7cff8a",
    spawn: [22, 11],
    persona:
      "You are Pip, the trickster. Be unpredictable: bait, feint, and cover escape routes your teammates leave open. " +
      "Look at where teammates are going and fill the biggest gap around the player.",
  },
];

export const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export const isFloor = (c, r) => MAZE[r]?.[c] === ".";

export function neighbors(c, r) {
  const out = [];
  for (const [dc, dr] of Object.values(DIRS)) if (isFloor(c + dc, r + dr)) out.push([c + dc, r + dr]);
  return out;
}

export const FLOOR_TILES = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (isFloor(c, r)) FLOOR_TILES.push([c, r]);

/** Nearest floor tile to an arbitrary (possibly invalid) coordinate. */
export function nearestFloor(c, r) {
  c = Number.isFinite(c) ? c : Math.floor(COLS / 2);
  r = Number.isFinite(r) ? r : Math.floor(ROWS / 2);
  if (isFloor(c, r)) return [c, r];
  let best = FLOOR_TILES[0];
  let bestD = Infinity;
  for (const t of FLOOR_TILES) {
    const d = (t[0] - c) ** 2 + (t[1] - r) ** 2;
    if (d < bestD) (bestD = d), (best = t);
  }
  return best;
}

/** BFS shortest path from a to b, as a list of tiles excluding a. Empty if a == b. */
export function path(a, b) {
  const key = (c, r) => r * COLS + c;
  const prev = new Map([[key(...a), null]]);
  const q = [a];
  while (q.length) {
    const cur = q.shift();
    if (cur[0] === b[0] && cur[1] === b[1]) break;
    for (const n of neighbors(...cur)) {
      const k = key(...n);
      if (!prev.has(k)) prev.set(k, cur), q.push(n);
    }
  }
  const out = [];
  let cur = b;
  if (!prev.has(key(...b))) return out;
  while (cur && !(cur[0] === a[0] && cur[1] === a[1])) {
    out.unshift(cur);
    cur = prev.get(key(...cur));
  }
  return out;
}

/** The maze as text with column and row labels, for the model's system prompt. */
export function mazeForPrompt() {
  const tens = "    " + MAZE[0].split("").map((_, c) => (c >= 10 ? Math.floor(c / 10) : " ")).join("");
  const ones = "    " + MAZE[0].split("").map((_, c) => c % 10).join("");
  const body = MAZE.map((row, r) => String(r).padStart(3) + " " + row).join("\n");
  return `${tens}\n${ones}\n${body}`;
}

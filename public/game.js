// Glowmaze — a neon maze chase where all five hunters are driven by an LLM on Wafer.
//
// The split that makes real-time AI work:
//   - The game runs at 60fps here: movement, collisions, pathfinding.
//   - Each hunter's *brain* is a loop of Wafer calls. Every call sees a snapshot of the game and
//     returns a target tile, an intent, and an optional radio line to the team.
//   - Pathfinding walks the hunter to its latest target until the next decision lands.
//
// So inference latency IS the hunters' reaction time: a decision made from a snapshot that is
// 250ms old still hits; one that is 2s old sends the hunter to where you used to be. The lag
// switch (L) adds 2s to every decision so you can feel the difference.

import {
  MAZE, COLS, ROWS, HUNTERS, DIRS, PLAYER_SPAWN, PULSE_TILES, isFloor, path, neighbors,
} from "./shared.js";
import { canSee, flood, nextJunctions, searchCandidates, junctionsVisibleFrom } from "./tactics.js";
import { openGuide } from "./onboarding.js";

const params = new URLSearchParams(location.search);
const AUTOPILOT = params.has("autopilot"); // a simple bot plays — handy for testing and attract mode
const LAG_MS = 2000;
const MIN_DECISION_GAP_MS = 150; // per hunter, so five hunters stay well under ~35 decisions/sec
const PLAYER_SPEED = Number(params.get("ps")) || 6.4; // tiles per second
const HUNTER_SPEED = Number(params.get("hs")) || 6.0; // a touch slower than you: they win by trapping, not racing
const STUN_MS = 3000;
const PULSE_RADIUS = 5;

// ---------- canvas ----------
// Everything is drawn in logical units of TILE px per tile, then scaled to fill the screen.
const TILE = 30;
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const DPR = Math.min(2, window.devicePixelRatio || 1);
let wallLayer;

function resize() {
  const box = document.getElementById("screen");
  const scale = Math.min(box.clientWidth / (COLS * TILE), box.clientHeight / (ROWS * TILE));
  canvas.width = Math.round(COLS * TILE * scale * DPR);
  canvas.height = Math.round(ROWS * TILE * scale * DPR);
  canvas.style.width = `${Math.round(COLS * TILE * scale)}px`;
  canvas.style.height = `${Math.round(ROWS * TILE * scale)}px`;
  ctx.setTransform(DPR * scale, 0, 0, DPR * scale, 0, 0);
  wallLayer = buildWalls(DPR * scale);
}
addEventListener("resize", resize);

const $ = (id) => document.getElementById(id);
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => ($("model").textContent = c.model))
  .catch(() => ($("model").textContent = "server offline"));

// ---------- state ----------
const game = {
  phase: "title", // title | play | caught | clear | over
  paused: false,
  epoch: 0, // bumps on every reset so late decisions from a previous life are ignored
  level: 1,
  score: 0,
  lives: 3,
  pulses: 1,
  sparks: new Set(),
  pulseTiles: new Set(),
  phaseUntil: 0,
  startedAt: performance.now(),
  lag: false,
  showPlans: true,
  pulseFx: null,
};

const key = (c, r) => `${c},${r}`;
const player = { from: [...PLAYER_SPAWN], to: [...PLAYER_SPAWN], t: 0, dir: null, want: null };
const hunters = HUNTERS.map((h) => ({
  ...h,
  from: [...h.spawn],
  to: [...h.spawn],
  t: 0,
  prev: null,
  target: null,
  intent: "waking up…",
  bubble: null,
  stunUntil: 0,
  lastReact: null,
  lastWafer: null,
  thinking: false,
}));
const radioLog = [];
const decisions = []; // rolling metrics

// Fog of war. Hunters only know where the player is when one of them can see them; sightings are
// shared across the team. Otherwise they work from the last sighting and search.
const intel = { at: [...PLAYER_SPAWN], heading: null, t: 0, by: [], visible: false };
const checkedAt = new Map(); // junction id -> last time any hunter had eyes on it

function resetBoard() {
  game.sparks.clear();
  game.pulseTiles = new Set(PULSE_TILES.map((t) => key(...t)));
  const noSpark = new Set([key(...PLAYER_SPAWN), ...HUNTERS.map((h) => key(...h.spawn)), ...game.pulseTiles]);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) if (isFloor(c, r) && !noSpark.has(key(c, r))) game.sparks.add(key(c, r));
}

function resetPositions() {
  game.epoch++;
  Object.assign(intel, { at: [...PLAYER_SPAWN], heading: null, t: performance.now(), by: ["respawn"], visible: false });
  checkedAt.clear();
  Object.assign(player, { from: [...PLAYER_SPAWN], to: [...PLAYER_SPAWN], t: 0, dir: null, want: null });
  for (const h of hunters) Object.assign(h, { from: [...h.spawn], to: [...h.spawn], t: 0, prev: null, target: null, stunUntil: 0, bubble: null, sees: false, alertUntil: 0 });
}

function newGame() {
  Object.assign(game, { level: 1, score: 0, lives: 3, pulses: 1, phase: "play", startedAt: performance.now() });
  radioLog.length = 0;
  renderRadio();
  resetBoard();
  resetPositions();
}

// ---------- input ----------
const KEYMAP = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right" };
addEventListener("keydown", (e) => {
  if (game.phase === "guide") return; // the onboarding screens handle their own keys
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (KEYMAP[k]) {
    player.want = KEYMAP[k];
    e.preventDefault();
  } else if (k === "Enter" && (game.phase === "title" || game.phase === "over")) newGame();
  else if (k === " ") {
    firePulse();
    e.preventDefault();
  } else if (k === "l") toggleLag();
  else if (k === "t") game.showPlans = !game.showPlans;
  else if (k === "p" || k === "Escape") game.paused = !game.paused;
  else if (k === "h") showGuide();
  else if (k === "f") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});
$("lag").onclick = toggleLag;
document.addEventListener("visibilitychange", () => document.hidden && (game.paused = true));

function toggleLag() {
  game.lag = !game.lag;
  decisions.length = 0; // stats restart so they show only the current mode
  $("lag").setAttribute("aria-pressed", String(game.lag));
  $("lagState").textContent = game.lag ? `+${LAG_MS / 1000}s LAG` : "LIVE";
  $("lag").querySelector(".lag-hint").textContent = game.lag ? "press L to go back to live" : `press L to add ${LAG_MS / 1000}s of lag`;
  document.querySelector(".hud").classList.toggle("lagging", game.lag);
}

function firePulse() {
  if (game.phase !== "play" || game.pulses <= 0) return;
  game.pulses--;
  const [px, py] = pos(player);
  game.pulseFx = { x: px, y: py, at: performance.now() };
  for (const h of hunters) {
    const [hx, hy] = pos(h);
    if (Math.hypot(hx - px, hy - py) <= PULSE_RADIUS) h.stunUntil = performance.now() + STUN_MS;
  }
}

// ---------- movement ----------
const pos = (e) => [e.from[0] + (e.to[0] - e.from[0]) * e.t, e.from[1] + (e.to[1] - e.from[1]) * e.t];
const tileOf = (e) => (e.t < 0.5 ? e.from : e.to);
const add = (t, d) => [t[0] + DIRS[d][0], t[1] + DIRS[d][1]];
const open = (t, d) => d && isFloor(...add(t, d));
const OPP = { up: "down", down: "up", left: "right", right: "left" };
const dirBetween = (a, b) => Object.keys(DIRS).find((d) => a[0] + DIRS[d][0] === b[0] && a[1] + DIRS[d][1] === b[1]);

function movePlayer(dt) {
  const moving = player.from[0] !== player.to[0] || player.from[1] !== player.to[1];
  if (moving && player.want === OPP[player.dir]) {
    [player.from, player.to] = [player.to, player.from];
    player.t = 1 - player.t;
    player.dir = player.want;
  }
  if (!moving) {
    if (AUTOPILOT) player.want = autopilot();
    if (open(player.from, player.want)) {
      player.dir = player.want;
      player.to = add(player.from, player.dir);
    } else return;
  }
  player.t += PLAYER_SPEED * dt;
  while (player.t >= 1) {
    player.t -= 1;
    player.from = player.to;
    arrive(player.from);
    if (AUTOPILOT) player.want = autopilot();
    if (open(player.from, player.want)) player.dir = player.want;
    if (open(player.from, player.dir)) player.to = add(player.from, player.dir);
    else {
      player.t = 0;
      break;
    }
  }
}

function arrive(tile) {
  const k = key(...tile);
  if (game.sparks.delete(k)) game.score += 10;
  if (game.pulseTiles.delete(k)) {
    game.pulses = Math.min(3, game.pulses + 1);
    game.score += 50;
  }
  if (game.sparks.size === 0 && game.phase === "play") {
    game.phase = "clear";
    game.phaseUntil = performance.now() + 2200;
  }
}

function moveHunter(h, dt, now) {
  if (h.stunUntil > now) return;
  const speed = HUNTER_SPEED * (1 + 0.06 * (game.level - 1));
  if (h.from[0] === h.to[0] && h.from[1] === h.to[1]) h.to = nextStep(h);
  if (h.from[0] === h.to[0] && h.from[1] === h.to[1]) return;
  h.t += speed * dt;
  while (h.t >= 1) {
    h.t -= 1;
    h.prev = h.from;
    h.from = h.to;
    h.to = nextStep(h);
  }
}

// Follow the AI's latest target. Once there, drift along the corridor until the next decision.
function nextStep(h) {
  if (h.target && !(h.from[0] === h.target[0] && h.from[1] === h.target[1])) {
    const p = path(h.from, h.target);
    if (p.length) return p[0];
  }
  const opts = neighbors(...h.from).filter((n) => !h.prev || n[0] !== h.prev[0] || n[1] !== h.prev[1]);
  const pool = opts.length ? opts : neighbors(...h.from);
  return pool[Math.floor(Math.random() * pool.length)] || h.from;
}

// ---------- the AI loop ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function brain(h) {
  for (;;) {
    if (game.phase !== "play" || game.paused) {
      await sleep(100);
      continue;
    }
    const epoch = game.epoch;
    const state = snapshot(h);
    const t0 = performance.now();
    h.thinking = true;
    let res, body;
    try {
      res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hunterId: h.id, epoch, state }),
      });
      body = await res.json();
    } catch (err) {
      body = { error: err.message };
    }
    if (game.lag) await sleep(LAG_MS);
    h.thinking = false;
    const react = performance.now() - t0;
    const ok = res?.ok && body.decision;
    decisions.push({ at: performance.now(), hunter: h.id, ok, react, wafer: body.timing?.totalMs, ttft: body.timing?.ttftMs,
      prompt: body.timing?.promptTokens, cached: body.timing?.cachedTokens, lag: game.lag });

    if (ok && epoch === game.epoch && game.phase === "play") {
      const d = body.decision;
      h.target = [d.col, d.row];
      h.intent = d.intent;
      h.lastReact = Math.round(react);
      h.lastWafer = body.timing?.totalMs;
      if (d.radio) say(h, d.radio);
    } else if (!ok) {
      h.intent = `⚠ ${body.error || "error"}`;
      await sleep((body.retryAfter || 1) * 1000);
    }
    await sleep(Math.max(0, MIN_DECISION_GAP_MS - (performance.now() - t0)));
  }
}

const HUNTER_TPS = () => HUNTER_SPEED * (1 + 0.06 * (game.level - 1));

function updateIntel(now) {
  const pt = tileOf(player);
  const seers = [];
  for (const h of hunters) {
    const ht = tileOf(h);
    for (const j of junctionsVisibleFrom(ht)) checkedAt.set(j.id, now);
    const sees = h.stunUntil <= now && canSee(ht, pt);
    if (sees && !h.sees) h.alertUntil = now + 900; // the "!" when a hunter spots you
    h.sees = sees;
    if (sees) seers.push(h.name);
  }
  const moving = player.from[0] !== player.to[0] || player.from[1] !== player.to[1];
  if (seers.length) Object.assign(intel, { at: pt, heading: moving ? player.dir : null, t: now, by: seers, visible: true });
  else intel.visible = false;
}

// What one hunter knows when it asks for a decision. The geometry is precomputed so the model
// only has to judge: which escape route to claim, or where to search.
function snapshot(h) {
  const now = performance.now();
  const me = tileOf(h);
  const mine = flood(me);
  const mates = hunters.filter((x) => x !== h).map((x) => ({ h: x, f: flood(tileOf(x)) }));
  const closestMate = (t) => {
    let best = null;
    for (const m of mates) {
      const d = m.f.dist(t);
      if (d >= 0 && (!best || d < best.dist)) best = { name: m.h.name, dist: d };
    }
    return best;
  };

  let playerInfo;
  if (intel.visible) {
    const p = intel.at;
    playerInfo = {
      status: "visible",
      seenBy: intel.by,
      at: p,
      heading: intel.heading ?? "stopped",
      in3Tiles: project(3),
      in6Tiles: project(6),
      distanceToYou: mine.dist(p),
      escapes: nextJunctions(p).map((e) => {
        const you = mine.dist(e.junction.at);
        return {
          junction: e.junction.id,
          at: e.junction.at,
          playerDist: e.dist,
          alongHeading: e.firstDir === intel.heading,
          you,
          youArriveFirst: you / HUNTER_TPS() < e.dist / PLAYER_SPEED,
          closestTeammate: closestMate(e.junction.at),
        };
      }),
    };
  } else {
    const ago = (now - intel.t) / 1000;
    const maxTiles = Math.ceil(ago * PLAYER_SPEED) + 2;
    playerInfo = {
      status: "hidden",
      lastSeen: { at: intel.at, heading: intel.heading ?? "unknown", secondsAgo: Math.round(ago * 10) / 10, by: intel.by },
      couldHaveMovedTiles: maxTiles,
      candidates: searchCandidates(intel, maxTiles, checkedAt, intel.t).map((c) => ({
        junction: c.j.id,
        at: c.j.at,
        fromLastSeen: c.d,
        alongLastHeading: c.along,
        checkedSinceSighting: !c.unchecked,
        you: mine.dist(c.j.at),
        closestTeammate: closestMate(c.j.at),
      })),
    };
  }

  const area = { NW: 0, NE: 0, SW: 0, SE: 0 };
  for (const k of game.sparks) {
    const [c, r] = k.split(",").map(Number);
    area[(r < ROWS / 2 ? "N" : "S") + (c < COLS / 2 ? "W" : "E")]++;
  }
  return {
    t: Math.round((now - game.startedAt) / 100) / 10,
    you: { name: h.name, at: me, target: h.target, stunned: h.stunUntil > now, seesPlayer: h.sees },
    player: playerInfo,
    playerPulseCharges: game.pulses,
    teammates: hunters
      .filter((x) => x !== h)
      .map((x) => ({ name: x.name, at: tileOf(x), target: x.target, intent: x.intent, stunned: x.stunUntil > now })),
    radio: radioLog.slice(-5).map((m) => `${m.name}: ${m.text}`),
    sparksLeft: { total: game.sparks.size, byArea: area },
  };
}

// Where the player will be in n tiles if they keep going (taking forced turns at corners).
function project(n) {
  let t = player.to;
  let d = player.dir;
  if (!d) return t;
  for (let i = 0; i < n; i++) {
    if (!open(t, d)) {
      const turns = Object.keys(DIRS).filter((x) => x !== OPP[d] && open(t, x));
      if (turns.length !== 1) break;
      d = turns[0];
    }
    t = add(t, d);
  }
  return t;
}

function say(h, text) {
  h.bubble = { text, until: performance.now() + 2600 };
  radioLog.push({ name: h.name, color: h.color, text });
  renderRadio();
}

// ---------- autopilot (testing / attract mode) ----------
function autopilot() {
  const here = player.from;
  const threats = hunters.filter((h) => path(here, tileOf(h)).length <= 4 && h.stunUntil < performance.now());
  const options = Object.keys(DIRS).filter((d) => open(here, d));
  if (threats.length) {
    if (game.pulses > 0 && threats.length >= 2) firePulse();
    const score = (d) => Math.min(...threats.map((h) => path(add(here, d), tileOf(h)).length));
    return options.sort((a, b) => score(b) - score(a))[0];
  }
  let best = null;
  let bestLen = Infinity;
  for (const k of game.sparks) {
    const tile = k.split(",").map(Number);
    if (Math.abs(tile[0] - here[0]) + Math.abs(tile[1] - here[1]) > bestLen) continue;
    const p = path(here, tile);
    if (p.length && p.length < bestLen) (bestLen = p.length), (best = p[0]);
  }
  return best ? dirBetween(here, best) : options[0];
}

// ---------- main loop ----------
let last = performance.now();
function frame() {
  requestAnimationFrame(frame); // schedule first so one bad frame can't stop the game
  const now = performance.now(); // one clock everywhere (rAF timestamps can trail performance.now())
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!game.paused) update(dt, now);
  draw(now);
}

function update(dt, now) {
  if (game.phase === "caught" && now > game.phaseUntil) {
    if (game.lives <= 0) game.phase = "over";
    else {
      resetPositions();
      game.phase = "play";
    }
  }
  if (game.phase === "clear" && now > game.phaseUntil) {
    game.level++;
    resetBoard();
    resetPositions();
    game.phase = "play";
  }
  if (game.phase !== "play") return;
  movePlayer(dt);
  for (const h of hunters) moveHunter(h, dt, now);
  updateIntel(now);
  const [px, py] = pos(player);
  for (const h of hunters) {
    if (h.stunUntil > now) continue;
    const [hx, hy] = pos(h);
    if (Math.hypot(hx - px, hy - py) < 0.7) {
      game.lives--;
      game.phase = "caught";
      game.phaseUntil = now + 1600;
      game.caughtBy = h;
      game.epoch++;
      break;
    }
  }
}

// ---------- drawing ----------
function buildWalls(pxPerUnit) {
  const c = document.createElement("canvas");
  c.width = Math.round(COLS * TILE * pxPerUnit);
  c.height = Math.round(ROWS * TILE * pxPerUnit);
  const g = c.getContext("2d");
  g.scale(pxPerUnit, pxPerUnit);
  g.strokeStyle = "#2f6bff";
  g.lineWidth = 2;
  g.lineCap = "round";
  g.shadowColor = "#2f6bff";
  g.shadowBlur = 12;
  // Walls are one tile thick, so draw each as a single neon line through the middle of the wall,
  // joining neighbouring wall tiles. A lone wall post becomes a short bar.
  const isWall = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS && !isFloor(c, r);
  const mid = (v) => v * TILE + TILE / 2;
  g.lineWidth = 3;
  g.beginPath();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      if (!isWall(c, r)) continue;
      if (isWall(c + 1, r)) g.moveTo(mid(c), mid(r)), g.lineTo(mid(c + 1), mid(r));
      if (isWall(c, r + 1)) g.moveTo(mid(c), mid(r)), g.lineTo(mid(c), mid(r + 1));
      // A wall that ends in a corridor must still visibly fill its tile, or the corridor looks open.
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => isWall(c + dc, r + dr));
      const stub = TILE * 0.42;
      if (n.length === 0) g.moveTo(mid(c) - stub, mid(r)), g.lineTo(mid(c) + stub, mid(r));
      if (n.length === 1) g.moveTo(mid(c), mid(r)), g.lineTo(mid(c) - n[0][0] * stub, mid(r) - n[0][1] * stub);
    }
  g.stroke();
  return c;
}

function draw(now) {
  ctx.fillStyle = "#020309";
  ctx.fillRect(0, 0, COLS * TILE, ROWS * TILE);
  ctx.drawImage(wallLayer, 0, 0, COLS * TILE, ROWS * TILE);

  // sparks and pulse orbs
  ctx.shadowBlur = 8;
  ctx.shadowColor = "#ffcf66";
  ctx.fillStyle = "#ffe9a8";
  for (const k of game.sparks) {
    const [c, r] = k.split(",").map(Number);
    ctx.fillRect(c * TILE + TILE / 2 - 2, r * TILE + TILE / 2 - 2, 4, 4);
  }
  const throb = 5 + Math.sin(now / 180) * 1.5;
  ctx.shadowColor = "#c58bff";
  ctx.fillStyle = "#e2c6ff";
  for (const k of game.pulseTiles) {
    const [c, r] = k.split(",").map(Number);
    circle(c * TILE + TILE / 2, r * TILE + TILE / 2, throb);
  }

  // AI plans: a dashed line from each hunter to the tile it decided to go to
  if (game.showPlans && game.phase === "play") {
    ctx.shadowBlur = 0;
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1.5;
    for (const h of hunters) {
      if (!h.target) continue;
      const [hx, hy] = pos(h).map((v) => v * TILE + TILE / 2);
      const tx = h.target[0] * TILE + TILE / 2;
      const ty = h.target[1] * TILE + TILE / 2;
      ctx.strokeStyle = h.color + "aa";
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(tx - 4, ty - 4), ctx.lineTo(tx + 4, ty + 4), ctx.moveTo(tx + 4, ty - 4), ctx.lineTo(tx - 4, ty + 4);
      ctx.stroke();
      ctx.setLineDash([3, 5]);
    }
    ctx.setLineDash([]);
  }

  // fog of war: where the team last saw you, and live sight lines
  if (game.phase === "play") {
    if (!intel.visible) {
      const age = (now - intel.t) / 1000;
      const [qx, qy] = intel.at.map((v) => v * TILE + TILE / 2);
      ctx.globalAlpha = Math.max(0.25, 1 - age / 12);
      ctx.strokeStyle = "#ff3b5c";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(qx, qy, 11 + Math.sin(now / 200) * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ff3b5c";
      ctx.font = "bold 13px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("?", qx, qy + 5);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    }
    const [sx, sy] = pos(player).map((v) => v * TILE + TILE / 2);
    for (const h of hunters) {
      if (!h.sees) continue;
      const [hx, hy] = pos(h).map((v) => v * TILE + TILE / 2);
      ctx.strokeStyle = h.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 10;
      ctx.shadowColor = h.color;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  }

  // player
  const [px, py] = pos(player).map((v) => v * TILE + TILE / 2);
  const flicker = game.phase === "caught" && Math.floor(now / 100) % 2;
  if (!flicker) {
    ctx.shadowBlur = 22;
    ctx.shadowColor = "#fff3b0";
    ctx.fillStyle = "#fffbe6";
    circle(px, py, 9);
    ctx.fillStyle = "#ffd75e";
    circle(px, py, 5);
  }

  // hunters
  for (const h of hunters) {
    const [hx, hy] = pos(h).map((v) => v * TILE + TILE / 2);
    const stunned = h.stunUntil > now;
    ctx.shadowBlur = stunned ? 0 : 16;
    ctx.shadowColor = h.color;
    ctx.fillStyle = stunned ? (Math.floor(now / 120) % 2 ? "#444a66" : "#8890b8") : h.color;
    hexagon(hx, hy, 10);
    // the eye looks where the hunter is heading
    const d = dirBetween(h.from, h.to);
    const [ex, ey] = d ? DIRS[d] : [0, 0];
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#05060a";
    circle(hx + ex * 3, hy + ey * 3, 3.6);
    ctx.fillStyle = "#fff";
    circle(hx + ex * 4, hy + ey * 4, 1.4);
    if (h.alertUntil > now) {
      ctx.fillStyle = "#fff";
      ctx.shadowBlur = 10;
      ctx.shadowColor = h.color;
      ctx.font = "bold 16px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("!", hx, hy - 16);
      ctx.textAlign = "left";
      ctx.shadowBlur = 0;
    }
    if (h.thinking && game.phase === "play") {
      ctx.strokeStyle = h.color;
      ctx.lineWidth = 1.5;
      const a = (now / 150) % (Math.PI * 2);
      ctx.beginPath();
      ctx.arc(hx, hy, 14, a, a + 1.2);
      ctx.stroke();
    }
  }

  // speech bubbles
  ctx.shadowBlur = 0;
  ctx.font = "600 11px 'JetBrains Mono', monospace";
  for (const h of hunters) {
    if (!h.bubble || h.bubble.until < now) continue;
    const [hx, hy] = pos(h).map((v) => v * TILE + TILE / 2);
    const text = h.bubble.text;
    const w = ctx.measureText(text).width + 14;
    const bx = Math.max(4, Math.min(COLS * TILE - w - 4, hx - w / 2));
    const by = Math.max(4, hy - 40);
    ctx.fillStyle = "rgba(5,6,10,.92)";
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 1.2;
    roundRect(bx, by, w, 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, bx + 7, by + 14);
  }

  // pulse ring
  if (game.pulseFx) {
    const age = Math.max(0, (now - game.pulseFx.at) / 500);
    if (age > 1) game.pulseFx = null;
    else {
      ctx.strokeStyle = `rgba(197,139,255,${1 - age})`;
      ctx.lineWidth = 3;
      ctx.shadowBlur = 20;
      ctx.shadowColor = "#c58bff";
      ctx.beginPath();
      ctx.arc(game.pulseFx.x * TILE + TILE / 2, game.pulseFx.y * TILE + TILE / 2, age * PULSE_RADIUS * TILE, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // overlays
  ctx.shadowBlur = 0;
  if (game.phase === "title") banner("GLOWMAZE", "ENTER TO PLAY · H FOR HOW TO PLAY", "#ffe9a8");
  else if (game.phase === "over") banner("GAME OVER", `SCORE ${game.score} · ENTER TO RETRY`, "#ff3b5c");
  else if (game.phase === "caught") banner("CAUGHT", `by ${game.caughtBy?.name ?? "the hunters"}`, game.caughtBy?.color ?? "#ff3b5c");
  else if (game.phase === "clear") banner("BOARD CLEAR", `LEVEL ${game.level + 1} · HUNTERS GET FASTER`, "#4dffb0");
  else if (game.paused) banner("PAUSED", "P TO RESUME", "#7c84a3");
  if (game.phase === "play") {
    const label = intel.visible
      ? `SPOTTED · ${intel.by.join(", ")}`
      : `HIDDEN ${((now - intel.t) / 1000).toFixed(1)}s`;
    ctx.font = "10px 'Press Start 2P', monospace";
    const w = ctx.measureText(label).width + 20;
    ctx.fillStyle = intel.visible ? "rgba(60,8,18,.85)" : "rgba(6,30,22,.85)";
    roundRect(TILE * 0.5, 6, w, 20, 5);
    ctx.fill();
    ctx.fillStyle = intel.visible ? "#ff3b5c" : "#4dffb0";
    ctx.fillText(label, TILE * 0.5 + 10, 20);
  }
  if (game.lag && game.phase === "play") {
    ctx.font = "10px 'Press Start 2P', monospace";
    ctx.fillStyle = Math.floor(now / 500) % 2 ? "#ff3b5c" : "#ff3b5c88";
    ctx.fillText(`+${LAG_MS / 1000}s INFERENCE LAG`, 12, ROWS * TILE - 10);
  }
}

function banner(title, sub, color) {
  ctx.fillStyle = "rgba(2,3,9,.72)";
  ctx.fillRect(0, ROWS * TILE * 0.38, COLS * TILE, 96);
  ctx.textAlign = "center";
  ctx.font = "26px 'Press Start 2P', monospace";
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.fillText(title, (COLS * TILE) / 2, ROWS * TILE * 0.38 + 46);
  ctx.shadowBlur = 0;
  ctx.font = "10px 'Press Start 2P', monospace";
  ctx.fillStyle = "#e6e9f5";
  ctx.fillText(sub, (COLS * TILE) / 2, ROWS * TILE * 0.38 + 76);
  ctx.textAlign = "left";
}

function circle(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function hexagon(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

// ---------- HUD ----------
const hunterRows = Object.fromEntries(
  hunters.map((h) => {
    const li = document.createElement("li");
    li.innerHTML = `<i style="background:${h.color};box-shadow:0 0 8px ${h.color}"></i><b style="color:${h.color}">${h.name}</b><span class="intent"></span><span class="ms"></span>`;
    $("hunters").append(li);
    return [h.id, li];
  })
);

function renderRadio() {
  const el = $("radio");
  if (!radioLog.length) return (el.innerHTML = `<li class="empty">quiet so far…</li>`);
  el.innerHTML = radioLog
    .slice(-9)
    .reverse()
    .map((m) => `<li><b style="color:${m.color}">${m.name}</b> ${escapeHtml(m.text)}</li>`)
    .join("");
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function pct(xs, q) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(q * v.length))]) : null;
}
const ms = (v) => (v == null ? "—" : `${v}ms`);

setInterval(() => {
  $("score").textContent = game.score;
  $("level").textContent = game.level;
  $("lives").textContent = "♥".repeat(Math.max(0, game.lives)) || "—";
  $("pulse").textContent = "●".repeat(game.pulses) || "—";

  const cutoff = performance.now() - 10_000;
  while (decisions.length && decisions[0].at < cutoff) decisions.shift();
  const ok = decisions.filter((d) => d.ok);
  $("sReact").textContent = ms(pct(ok.map((d) => d.react), 0.5));
  const p50 = pct(ok.map((d) => d.wafer), 0.5);
  const p95 = pct(ok.map((d) => d.wafer), 0.95);
  $("sLat").textContent = p50 == null ? "—" : `${p50} / ${p95}ms`;
  $("sTtft").textContent = ms(pct(ok.map((d) => d.ttft), 0.5));
  $("sRate").textContent = decisions.length ? (decisions.length / 10).toFixed(1) : "—";
  const prompt = ok.reduce((s, d) => s + (d.prompt || 0), 0);
  const cached = ok.reduce((s, d) => s + (d.cached || 0), 0);
  $("sCache").textContent = prompt ? `${Math.round((cached / prompt) * 100)}%` : "—";
  $("sErr").textContent = decisions.length - ok.length;

  for (const h of hunters) {
    const li = hunterRows[h.id];
    li.querySelector(".intent").textContent = h.intent;
    li.querySelector(".ms").textContent = ms(h.lastReact);
  }
}, 250);

// ---------- onboarding ----------
function showGuide() {
  const resumeTo = game.phase === "play" ? "play" : null;
  game.paused = true;
  game.phase = "guide";
  openGuide(() => {
    game.paused = false;
    if (resumeTo) game.phase = resumeTo;
    else newGame();
  });
}

// ---------- go ----------
resize();
resetBoard();
renderRadio();
hunters.forEach(brain);
if (params.has("autostart")) newGame();
else showGuide();
requestAnimationFrame(frame);

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
  MAZE, COLS, ROWS, HUNTERS, DIRS, PLAYER_SPAWN, PULSE_TILES, FLOOR_TILES, isFloor, isOpen, tempWalls, path, neighbors,
} from "./shared.js";
import { canSee, flood, nextJunctions, searchCandidates, junctionsVisibleFrom, JUNCTION_BY_ID } from "./tactics.js";
import { openGuide } from "./onboarding.js";

const params = new URLSearchParams(location.search);
const AUTOPILOT = params.has("autopilot"); // a simple bot plays — handy for testing and attract mode
const LAG_MS = 2000;
const MIN_DECISION_GAP_MS = 150; // the chaser re-decides almost back-to-back
const COVER_DECISION_GAP_MS = 600; // covers mostly follow the chaser's orders, so they think less often
const PING_FRESH_MS = 400; // you count as "pinging" while you've moved this recently
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
  .then((c) => {
    $("model").textContent = c.model;
    if (c.stale) {
      $("model").innerHTML = `${c.model}<br><b style="color:#ff3b5c">⚠ The server is running old code. Restart it (Ctrl+C, then npm start).</b>`;
    }
  })
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
  revealUntil: 0,
  revealBy: "",
  powerStats: { used: 0, rejected: 0, ai: 0, auto: 0 },
  orderStats: { ai: 0, auto: 0 },
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

// Every step you take broadcasts your position. The nearest hunter becomes the chaser: the ping wakes
// it immediately, it plans the route to you and radios orders that send teammates to cover escapes.
const pings = []; // { at, t0 } for the sonar ripple

// Powers. The model asks for one in its decision; code checks it is legal, telegraphs it for
// POWER_WINDUP_MS so the player can react, then applies it.
const POWER_WINDUP_MS = 500;
const SNARE_FREEZE_MS = 1500;
const fx = {
  walls: new Map(), // tile index -> { until, owner }
  sludge: [], // { tiles: Set<index>, at, until, owner }
  snares: new Map(), // tile index -> { until, owner }
  flares: [], // { at, until, owner, radius }
  pending: [], // { owner, power, at, fireAt, epoch }
  bursts: [], // { at, color, t0, label }
};
const tIdx = ([c, r]) => r * COLS + c;
const fromIdx = (i) => [i % COLS, Math.floor(i / COLS)];
const SHORT = { wall: "WALL", blink: "BLINK", flare: "FLARE", sludge: "SLUDGE", snare: "SNARE" };

function clearEffects() {
  fx.walls.clear();
  tempWalls.clear();
  fx.sludge.length = 0;
  fx.snares.clear();
  fx.flares.length = 0;
  fx.pending.length = 0;
  fx.bursts.length = 0;
}

function resetBoard() {
  game.sparks.clear();
  game.pulseTiles = new Set(PULSE_TILES.map((t) => key(...t)));
  const noSpark = new Set([key(...PLAYER_SPAWN), ...HUNTERS.map((h) => key(...h.spawn)), ...game.pulseTiles]);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) if (isOpen(c, r) && !noSpark.has(key(c, r))) game.sparks.add(key(c, r));
}

function resetPositions() {
  game.epoch++;
  Object.assign(intel, { at: [...PLAYER_SPAWN], heading: null, t: performance.now(), by: ["respawn"], visible: false });
  checkedAt.clear();
  clearEffects();
  game.revealUntil = 0;
  game.lastPingAt = 0;
  pings.length = 0;
  Object.assign(player, { from: [...PLAYER_SPAWN], to: [...PLAYER_SPAWN], t: 0, dir: null, want: null, frozenUntil: 0 });
  for (const h of hunters) Object.assign(h, { from: [...h.spawn], to: [...h.spawn], t: 0, prev: null, target: null, stunUntil: 0, bubble: null, sees: false, alertUntil: 0, powerReadyAt: performance.now() + 4000, powerNote: "", powerNoteUntil: 0, role: "cover", order: null });
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
  // the pulse also breaks the hunters' map tricks around you
  const near = (i) => Math.hypot(fromIdx(i)[0] - px, fromIdx(i)[1] - py) <= PULSE_RADIUS;
  for (const i of [...fx.walls.keys()]) if (near(i)) fx.walls.delete(i), tempWalls.delete(i);
  for (const s of fx.sludge) for (const i of [...s.tiles]) if (near(i)) s.tiles.delete(i);
  for (const i of [...fx.snares.keys()]) if (near(i)) fx.snares.delete(i);
}

// ---------- movement ----------
const pos = (e) => [e.from[0] + (e.to[0] - e.from[0]) * e.t, e.from[1] + (e.to[1] - e.from[1]) * e.t];
const tileOf = (e) => (e.t < 0.5 ? e.from : e.to);
const add = (t, d) => [t[0] + DIRS[d][0], t[1] + DIRS[d][1]];
const open = (t, d) => d && isFloor(...add(t, d));
const OPP = { up: "down", down: "up", left: "right", right: "left" };
const dirBetween = (a, b) => Object.keys(DIRS).find((d) => a[0] + DIRS[d][0] === b[0] && a[1] + DIRS[d][1] === b[1]);

const inSludge = (t) => fx.sludge.some((s) => s.tiles.has(tIdx(t)));

function movePlayer(dt) {
  if (player.frozenUntil > performance.now()) return; // caught in Pip's snare
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
  player.t += PLAYER_SPEED * (inSludge(tileOf(player)) ? 0.5 : 1) * dt;
  while (player.t >= 1) {
    player.t -= 1;
    player.from = player.to;
    arrive(player.from);
    ping(player.from);
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
  const snare = fx.snares.get(tIdx(tile));
  if (snare) {
    const now = performance.now();
    fx.snares.delete(tIdx(tile));
    player.frozenUntil = now + SNARE_FREEZE_MS;
    game.revealUntil = now + SNARE_FREEZE_MS;
    game.revealBy = `${snare.owner.name}'s snare`;
    fx.bursts.push({ at: tile, color: snare.owner.color, t0: now, label: "SNARED!" });
  }
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
      // a cover that got fresh orders while this decision was in flight keeps the orders
      const overtaken = h.role === "cover" && h.order && h.order.t > t0;
      if (!overtaken) h.target = [d.col, d.row];
      if (h.role === "chaser" && state.role === "chaser") {
        const given = giveOrders(h, d.orders, "ai");
        if (!given) giveOrders(h, autoOrders(h, state), "auto");
      }
      h.intent = d.intent;
      h.lastReact = Math.round(react);
      h.lastWafer = body.timing?.totalMs;
      if (d.radio) say(h, d.radio);
      if (d.usePower) requestPower(h, [d.powerCol, d.powerRow], performance.now(), "ai");
      else autoPower(h, state, performance.now());
    } else if (!ok) {
      h.intent = `⚠ ${body.error || "error"}`;
      await sleep((body.retryAfter || 1) * 1000);
    }
    const gap = h.role === "chaser" ? MIN_DECISION_GAP_MS : COVER_DECISION_GAP_MS;
    await sleepOrWake(h, Math.max(0, gap - (performance.now() - t0)));
  }
}

// A hunter's loop sleeps between decisions, but a ping can wake it early. If it's mid-request,
// the wake is remembered and it re-decides as soon as the current answer lands.
function wake(h) {
  h.wakeRequested = true;
  h.wakeResolve?.();
}
function sleepOrWake(h, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      h.wakeResolve = null;
      h.wakeRequested = false;
      resolve();
    };
    const timer = setTimeout(done, ms);
    h.wakeResolve = done;
    if (h.wakeRequested) done();
  });
}

function ping(tile) {
  const now = performance.now();
  game.lastPingAt = now;
  pings.push({ at: [...tile], t0: now });
  // the nearest hunter by real path length becomes the chaser (with a little hysteresis so it
  // doesn't flip every step between two hunters at the same distance)
  const f = flood(tile);
  const current = hunters.find((x) => x.role === "chaser");
  let best = null;
  for (const h of hunters) {
    if (h.stunUntil > now) continue;
    const d = f.dist(tileOf(h));
    if (d >= 0 && (!best || d < best.d)) best = { h, d };
  }
  if (!best) return;
  const curD = current && current.stunUntil <= now ? f.dist(tileOf(current)) : Infinity;
  const chaser = current && curD >= 0 && curD <= best.d + 2 ? current : best.h;
  if (chaser !== current) {
    for (const h of hunters) h.role = h === chaser ? "chaser" : "cover";
    chaser.order = null;
  }
  wake(chaser);
}

function giveOrders(chaser, orders, source) {
  if (!Array.isArray(orders)) return 0;
  const now = performance.now();
  const given = [];
  const taken = new Set([String(chaser.target)]); // one hunter per junction, and not where the chaser is going
  const assigned = new Set();
  for (const o of orders.slice(0, 4)) {
    const mate = hunters.find((x) => x !== chaser && x.name.toLowerCase() === String(o.name || "").toLowerCase());
    const j = JUNCTION_BY_ID.get(String(o.junction || "").toUpperCase());
    if (!mate || !j || assigned.has(mate) || taken.has(String(j.at))) continue;
    assigned.add(mate);
    taken.add(String(j.at));
    mate.target = [...j.at];
    mate.order = { junction: j.id, at: j.at, from: chaser.name, t: now };
    mate.intent = `cover ${j.id} (${chaser.name}'s call)`;
    given.push(`${mate.name} → ${j.id}`);
  }
  // a new round of orders replaces the old one; anyone not named this round is free again
  if (given.length) for (const x of hunters) if (x !== chaser && !assigned.has(x)) x.order = null;
  const text = `📡 ${given.join(" · ")}`;
  if (given.length && text !== chaser.lastOrders) say(chaser, text); // only announce changes
  if (given.length) (chaser.lastOrders = text), (game.orderStats[source] += 1);
  return given.length;
}

// Fallback when the chaser gives no orders: each escape junction (from the same snapshot the chaser
// decided on) goes to the nearest teammate who is not already assigned.
function autoOrders(chaser, state) {
  const pl = state.player;
  const spots =
    pl.status === "visible"
      ? [...pl.escapes].sort((a, b) => b.alongHeading - a.alongHeading || a.playerDist - b.playerDist).map((e) => e.junction)
      : pl.candidates.map((c) => c.junction);
  const free = hunters.filter((x) => x !== chaser && x.stunUntil <= performance.now());
  const out = [];
  for (const id of spots) {
    const j = JUNCTION_BY_ID.get(id);
    let best = null;
    for (const m of free) {
      if (out.some((o) => o.name === m.name)) continue;
      const d = flood(tileOf(m)).dist(j.at);
      if (d >= 0 && (!best || d < best.d)) best = { m, d };
    }
    if (best) out.push({ name: best.m.name, junction: id });
  }
  return out;
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
  const [px, py] = pos(player);
  const flare = fx.flares.find((f) => Math.hypot(f.at[0] - px, f.at[1] - py) <= f.radius);
  if (flare) seers.push(`${flare.owner.name}'s flare`);
  if (game.revealUntil > now) seers.push(game.revealBy);
  if (now - game.lastPingAt < PING_FRESH_MS) seers.push("ping");
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
    role: h.role,
    ...(h.role === "cover" && h.order
      ? { yourOrder: { junction: h.order.junction, at: h.order.at, from: h.order.from, secondsAgo: Math.round((now - h.order.t) / 100) / 10 } }
      : {}),
    yourPower: {
      name: h.power.name,
      ready: now >= h.powerReadyAt && h.stunUntil <= now,
      readyInSeconds: Math.max(0, Math.ceil((h.powerReadyAt - now) / 1000)),
      ...(h.powerNoteUntil > now ? { lastAttempt: h.powerNote } : {}),
    },
    effects: effectsSummary(now),
    player: playerInfo,
    playerPulseCharges: game.pulses,
    teammates: hunters
      .filter((x) => x !== h)
      .map((x) => ({
        name: x.name, at: tileOf(x), target: x.target, intent: x.intent, stunned: x.stunUntil > now,
        power: x.power.name, powerReady: now >= x.powerReadyAt,
      })),
    radio: radioLog.slice(-5).map((m) => `${m.name}: ${m.text}`),
    sparksLeft: { total: game.sparks.size, byArea: area },
  };
}

// ---------- powers ----------
function effectsSummary(now) {
  const left = (u) => Math.max(0, Math.round((u - now) / 100) / 10);
  return {
    walls: [...fx.walls].map(([i, w]) => ({ at: fromIdx(i), by: w.owner.name, secondsLeft: left(w.until) })),
    sludge: fx.sludge.filter((s) => s.tiles.size).map((s) => ({ at: s.at, tiles: s.tiles.size, secondsLeft: left(s.until) })),
    flares: fx.flares.map((f) => ({ at: f.at, radius: f.radius, secondsLeft: left(f.until) })),
    snares: [...fx.snares].map(([i, s]) => ({ at: fromIdx(i), secondsLeft: left(s.until) })),
    incoming: fx.pending.map((p) => ({ power: p.power.name, by: p.owner.name, at: p.at })),
  };
}

const occupied = (t) =>
  [player.from, player.to, ...hunters.flatMap((x) => [x.from, x.to])].some((o) => o[0] === t[0] && o[1] === t[1]);

// Why this power use is illegal right now, or null if it's fine. Enforced in code, not trusted to the model.
function invalidPower(h, id, at) {
  if (!isOpen(...at)) return "not a floor tile";
  const dPlayer = flood(tileOf(player)).dist(at);
  if (id === "wall") {
    if (!isFloor(...at)) return "already walled";
    if (dPlayer >= 0 && dPlayer < 3) return "too close to the player";
    if (occupied(at)) return "someone is standing there";
    if (fx.walls.size >= 3) return "three walls already up";
    tempWalls.add(tIdx(at));
    const room = flood(tileOf(player)).reached;
    tempWalls.delete(tIdx(at));
    if (room < FLOOR_TILES.length * 0.5) return "would seal the player in";
  }
  if (id === "blink") {
    if (!isFloor(...at)) return "blocked";
    if (dPlayer >= 0 && dPlayer < 5) return "too close to the player";
  }
  if (id === "sludge" && dPlayer >= 0 && dPlayer < 2) return "too close to the player";
  if (id === "snare") {
    if (dPlayer >= 0 && dPlayer < 4) return "too close to the player";
    if ([...fx.snares.values()].filter((s) => s.owner === h).length >= 2) return "two snares already set";
  }
  return null;
}

function requestPower(h, at, now, source) {
  const why =
    now < h.powerReadyAt ? "still cooling down" : h.stunUntil > now ? "stunned" : invalidPower(h, h.power.id, at);
  if (why) {
    h.powerNote = `${SHORT[h.power.id]} rejected: ${why}`;
    h.powerNoteUntil = now + 3000;
    game.powerStats.rejected++;
    return false;
  }
  h.powerReadyAt = now + h.power.cooldown * 1000;
  fx.pending.push({ owner: h, power: h.power, at, fireAt: now + POWER_WINDUP_MS, epoch: game.epoch, source });
  game.powerStats[source]++;
  if (source === "auto") (h.powerNote = `${SHORT[h.power.id]} (auto)`), (h.powerNoteUntil = now + 2500);
  return true;
}

// Fallback so powers actually get used: if the model has left a ready power unused for
// AUTO_POWER_AFTER_MS, fire it at a target chosen by simple rules. Targets come from the same
// snapshot the decision was based on, so with the lag switch on, auto powers land late too.
const AUTO_POWER_AFTER_MS = 1500;
function autoPower(h, state, now) {
  if (now - h.powerReadyAt < AUTO_POWER_AFTER_MS || h.stunUntil > now) return;
  if (fx.pending.some((p) => p.owner === h)) return;
  const pl = state.player;
  let picks = [];
  if (pl.status === "visible") {
    const escapes = [...pl.escapes].sort((a, b) => b.alongHeading - a.alongHeading || a.playerDist - b.playerDist);
    const ahead = escapes.map((e) => e.at);
    picks = {
      wall: ahead, // seal where they're running
      blink: [...escapes.filter((e) => !e.youArriveFirst).map((e) => e.at), ...ahead], // appear where you can't run to in time
      sludge: [pl.in3Tiles, pl.in6Tiles, ...ahead],
      snare: [pl.in6Tiles, ...ahead],
      flare: [], // pointless when they're already seen
    }[h.power.id];
  } else {
    const likely = pl.candidates.map((c) => c.at);
    picks = h.power.id === "flare" || h.power.id === "blink" || h.power.id === "snare" ? likely : [];
  }
  for (const at of picks) {
    if (at && !invalidPower(h, h.power.id, at)) return void requestPower(h, at, now, "auto");
  }
}

function firePower(p, now) {
  const h = p.owner;
  const why = invalidPower(h, p.power.id, p.at); // the board changed during the wind-up
  if (why) {
    h.powerNote = `${SHORT[p.power.id]} fizzled: ${why}`;
    h.powerNoteUntil = now + 3000;
    game.powerStats.rejected++;
    return;
  }
  game.powerStats.used++;
  const until = now + (p.power.duration || 0) * 1000;
  const label = p.power.name.toUpperCase() + "!";
  if (p.power.id === "wall") {
    fx.walls.set(tIdx(p.at), { until, owner: h });
    tempWalls.add(tIdx(p.at));
  } else if (p.power.id === "blink") {
    fx.bursts.push({ at: tileOf(h), color: h.color, t0: now });
    Object.assign(h, { from: [...p.at], to: [...p.at], t: 0, prev: null });
  } else if (p.power.id === "flare") {
    fx.flares.push({ at: p.at, until, owner: h, radius: p.power.radius });
  } else if (p.power.id === "sludge") {
    fx.sludge.push({ tiles: new Set(sludgeTiles(p.at).map(tIdx)), at: p.at, until, owner: h });
  } else if (p.power.id === "snare") {
    fx.snares.set(tIdx(p.at), { until, owner: h });
  }
  fx.bursts.push({ at: p.at, color: h.color, t0: now, label });
}

// Up to 5 tiles along whichever straight corridor through `at` is longer.
function sludgeTiles(at) {
  const run = (dc, dr) => {
    const out = [];
    for (let i = 1; i <= 2 && isOpen(at[0] + dc * i, at[1] + dr * i); i++) out.push([at[0] + dc * i, at[1] + dr * i]);
    return out;
  };
  const h = [...run(-1, 0), ...run(1, 0)];
  const v = [...run(0, -1), ...run(0, 1)];
  return [at, ...(h.length >= v.length ? h : v)];
}

function tickEffects(now) {
  for (const [i, w] of [...fx.walls]) if (w.until <= now) fx.walls.delete(i), tempWalls.delete(i);
  for (const [i, s] of [...fx.snares]) if (s.until <= now) fx.snares.delete(i);
  fx.sludge = fx.sludge.filter((s) => s.until > now && s.tiles.size);
  fx.flares = fx.flares.filter((f) => f.until > now);
  fx.bursts = fx.bursts.filter((b) => now - b.t0 < 1100);
  const due = fx.pending.filter((p) => p.fireAt <= now);
  fx.pending = fx.pending.filter((p) => p.fireAt > now);
  for (const p of due) if (p.epoch === game.epoch) firePower(p, now);
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
  tickEffects(now);
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

  drawEffects(now);

  // sonar ripples: every step you take is broadcast
  for (let i = pings.length - 1; i >= 0; i--) {
    const age = (now - pings[i].t0) / 700;
    if (age > 1) {
      pings.splice(i, 1);
      continue;
    }
    ctx.strokeStyle = `rgba(255,59,92,${0.55 * (1 - age)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx(pings[i].at[0]), cx(pings[i].at[1]), 6 + age * 22, 0, Math.PI * 2);
    ctx.stroke();
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
  if (player.frozenUntil > now) {
    ctx.strokeStyle = "#bfefff";
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 14;
    ctx.shadowColor = "#7fdcff";
    ctx.beginPath();
    ctx.arc(px, py, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
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
    if (h.role === "chaser" && game.phase === "play") {
      // crosshair brackets mark the chaser
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      const r = 15, k = 5;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(hx + sx * r, hy + sy * (r - k)), ctx.lineTo(hx + sx * r, hy + sy * r), ctx.lineTo(hx + sx * (r - k), hy + sy * r);
      }
      ctx.stroke();
    }
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

  drawPowerCallouts(now);

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
    const sighted = intel.by.filter((b) => b !== "ping");
    const label = !intel.visible
      ? `SILENT ${((now - intel.t) / 1000).toFixed(1)}s`
      : sighted.length
        ? `SPOTTED · ${sighted.join(", ")}`
        : "PINGING · stand still to go silent";
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

const cx = (v) => v * TILE + TILE / 2;

function drawEffects(now) {
  ctx.save();
  // flares: a lit disc
  for (const f of fx.flares) {
    const life = Math.min(1, (f.until - now) / 1000);
    const g = ctx.createRadialGradient(cx(f.at[0]), cx(f.at[1]), 0, cx(f.at[0]), cx(f.at[1]), f.radius * TILE);
    g.addColorStop(0, `rgba(61,214,255,${0.32 * life})`);
    g.addColorStop(1, "rgba(61,214,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx(f.at[0]), cx(f.at[1]), f.radius * TILE, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(61,214,255,${0.5 * life})`;
    ctx.setLineDash([4, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // sludge: bubbling goo on the floor
  for (const s of fx.sludge) {
    const fade = (s.until - now) < 1000 && Math.floor(now / 120) % 2 ? 0.12 : 0.3;
    for (const i of s.tiles) {
      const [c, r] = fromIdx(i);
      ctx.fillStyle = `rgba(179,136,255,${fade})`;
      ctx.fillRect(c * TILE + 2, r * TILE + 2, TILE - 4, TILE - 4);
      ctx.fillStyle = "rgba(220,200,255,.55)";
      const b = (now / 300 + c * 7 + r * 3) % 1;
      circle(c * TILE + 8 + ((c * 13) % 14), r * TILE + TILE - 6 - b * 16, 1.6 + b);
    }
  }
  // snares: barely-visible glints so a careful player can spot them
  for (const [i, sn] of fx.snares) {
    const [c, r] = fromIdx(i);
    ctx.globalAlpha = 0.25 + 0.15 * Math.sin(now / 250 + i);
    ctx.strokeStyle = sn.owner.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx(c), cx(r) - 6), ctx.lineTo(cx(c) + 6, cx(r)), ctx.lineTo(cx(c), cx(r) + 6), ctx.lineTo(cx(c) - 6, cx(r)), ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // walls: a solid glowing block in the owner's colour, flickering in its last second
  for (const [i, w] of fx.walls) {
    if (w.until - now < 1000 && Math.floor(now / 100) % 2) continue;
    const [c, r] = fromIdx(i);
    ctx.fillStyle = w.owner.color;
    ctx.shadowBlur = 18;
    ctx.shadowColor = w.owner.color;
    ctx.fillRect(c * TILE + 4, r * TILE + 4, TILE - 8, TILE - 8);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(c * TILE + 4, r * TILE + 4, TILE - 8, TILE - 8);
  }
  ctx.restore();
}

// The wind-up warning before a power lands, and a burst + label when it does.
function drawPowerCallouts(now) {
  ctx.save();
  ctx.textAlign = "center";
  for (const p of fx.pending) {
    const on = Math.floor(now / 90) % 2;
    ctx.strokeStyle = p.owner.color;
    ctx.globalAlpha = on ? 1 : 0.4;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    if (p.power.id === "flare") {
      ctx.beginPath();
      ctx.arc(cx(p.at[0]), cx(p.at[1]), p.power.radius * TILE, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.power.id === "sludge") {
      for (const t of sludgeTiles(p.at)) ctx.strokeRect(t[0] * TILE + 2, t[1] * TILE + 2, TILE - 4, TILE - 4);
    } else ctx.strokeRect(p.at[0] * TILE + 1, p.at[1] * TILE + 1, TILE - 2, TILE - 2);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.fillStyle = p.owner.color;
    ctx.fillText(SHORT[p.power.id], cx(p.at[0]), p.at[1] * TILE - 4);
  }
  for (const b of fx.bursts) {
    const age = (now - b.t0) / 1000;
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = Math.max(0, 1 - age / 0.6);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx(b.at[0]), cx(b.at[1]), 6 + age * 50, 0, Math.PI * 2);
    ctx.stroke();
    if (b.label) {
      ctx.globalAlpha = Math.max(0, 1 - age / 1.1);
      ctx.font = "10px 'Press Start 2P', monospace";
      ctx.fillStyle = b.color;
      ctx.shadowBlur = 10;
      ctx.shadowColor = b.color;
      ctx.fillText(b.label, cx(b.at[0]), b.at[1] * TILE - 8 - age * 18);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
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
    li.innerHTML = `<i style="background:${h.color};box-shadow:0 0 8px ${h.color}"></i><b style="color:${h.color}">${h.name}</b><span class="intent"></span><span class="pw"></span><span class="ms"></span>`;
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
    const now = performance.now();
    li.querySelector(".intent").textContent = h.powerNoteUntil > now ? h.powerNote : h.intent;
    const left = Math.ceil((h.powerReadyAt - now) / 1000);
    const pw = li.querySelector(".pw");
    pw.textContent = left > 0 ? `${SHORT[h.power.id]} ${left}s` : `${SHORT[h.power.id]} ✓`;
    pw.classList.toggle("ready", left <= 0);
    pw.style.setProperty("--c", h.color);
    li.querySelector(".ms").textContent = ms(h.lastReact);
    li.classList.toggle("chaser", h.role === "chaser" && game.phase === "play");
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
if (AUTOPILOT) window.__glowmaze = { game, fx, hunters }; // test hook
if (params.has("autostart")) newGame();
else showGuide();
requestAnimationFrame(frame);

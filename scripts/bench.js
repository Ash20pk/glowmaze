// Which Wafer model makes the best hunter brain? Sends the game's real hunter prompt and a
// realistic game state to each model and measures what the game cares about: time to a complete,
// valid decision (the hunter can't move on half a JSON object), plus time to first token.
//
//   node scripts/bench.js                          # every model in the catalog, 8 runs each
//   node scripts/bench.js GLM-5.3-Flash --runs 20

import { readFileSync, existsSync } from "node:fs";
import { SYSTEM, SCHEMA } from "../prompt.js";
import { isFloor } from "../public/shared.js";
import { flood, nextJunctions } from "../public/tactics.js";

if (existsSync(".env"))
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }

const KEY = process.env.WAFER_API_KEY;
const BASE = (process.env.WAFER_BASE_URL || "https://pass.wafer.ai/v1").replace(/\/$/, "");
if (!KEY) throw new Error("Set WAFER_API_KEY (or put it in .env)");

const args = process.argv.slice(2);
const ri = args.indexOf("--runs");
const RUNS = ri >= 0 ? Number(args.splice(ri, 2)[1]) : 8;
let models = args;
if (!models.length)
  models = (await (await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } })).json()).data.map((m) => m.id);

// A realistic mid-game state, built with the same tactics code the game uses.
const PLAYER = { at: [9, 17], heading: "right" };
const TEAM = { Vex: [20, 11], Rook: [5, 17], Moth: [24, 19], Grim: [9, 11], Pip: [31, 5] };
const fl = Object.fromEntries(Object.entries(TEAM).map(([n, t]) => [n, flood(t)]));
const closest = (t, except) =>
  Object.keys(TEAM).filter((n) => n !== except).map((n) => ({ name: n, dist: fl[n].dist(t) })).sort((a, b) => a.dist - b.dist)[0];
const STATE = {
  t: 23.4,
  you: { name: "Vex", at: TEAM.Vex, target: [24, 13], stunned: false, seesPlayer: false },
  player: {
    status: "visible",
    seenBy: ["Rook"],
    at: PLAYER.at,
    heading: PLAYER.heading,
    in3Tiles: [11, 17],
    in6Tiles: [11, 15],
    distanceToYou: fl.Vex.dist(PLAYER.at),
    escapes: nextJunctions(PLAYER.at).map((e) => ({
      junction: e.junction.id, at: e.junction.at, playerDist: e.dist, alongHeading: e.firstDir === PLAYER.heading,
      you: fl.Vex.dist(e.junction.at), youArriveFirst: fl.Vex.dist(e.junction.at) / 6 < e.dist / 6.4,
      closestTeammate: closest(e.junction.at, "Vex"),
    })),
  },
  playerPulseCharges: 1,
  teammates: [
    { name: "Rook", at: TEAM.Rook, target: [8, 17], intent: "chase from behind", stunned: false },
    { name: "Moth", at: TEAM.Moth, target: [22, 19], intent: "guard south-east sparks", stunned: false },
    { name: "Grim", at: TEAM.Grim, target: [9, 13], intent: "block the north exit", stunned: false },
    { name: "Pip", at: TEAM.Pip, target: [25, 7], intent: "drift toward center", stunned: false },
  ],
  radio: ["Rook: spotted him running east on row 17", "Grim: I've got the north side"],
  sparksLeft: { total: 380, byArea: { NW: 92, NE: 99, SW: 91, SE: 98 } },
};

async function once(model, attempt = 0) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: true, max_tokens: 300, temperature: 0.6, reasoning_effort: "none", response_format: SCHEMA,
      messages: [{ role: "system", content: SYSTEM.vex }, { role: "user", content: JSON.stringify(STATE) }],
    }),
  });
  if (res.status === 429 && attempt < 3) {
    // Wafer sheds load with 429 + Retry-After rather than queueing; honour it and try again
    await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 1) * 1000));
    return once(model, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 140)}`);
  let ttft = null, text = "", buf = "", usage = null;
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:") || line.endsWith("[DONE]")) continue;
      const evt = JSON.parse(line.slice(5));
      if (evt.usage) usage = evt.usage;
      const piece = evt.choices?.[0]?.delta?.content;
      if (piece) (ttft ??= performance.now() - t0), (text += piece);
    }
  }
  let valid = false;
  try {
    const d = JSON.parse(text);
    valid = Number.isInteger(d.col) && Number.isInteger(d.row) && isFloor(d.col, d.row);
  } catch {}
  return { ttft, total: performance.now() - t0, valid, cached: usage?.prompt_tokens_details?.cached_tokens ?? 0, prompt: usage?.prompt_tokens ?? 0 };
}

const pct = (xs, q) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(q * v.length))]) : NaN;
};

const rows = [];
for (const model of models) {
  const r = [];
  let error;
  for (let i = 0; i < RUNS; i++) {
    try { r.push(await once(model)); } catch (e) { error = e.message; break; }
  }
  if (error?.startsWith("402")) {
    console.error("\nOut of Wafer credits. Add some at https://app.wafer.ai and run again.");
    process.exit(1);
  }
  const row = {
    model,
    "decision p50": pct(r.map((x) => x.total), 0.5),
    "decision p95": pct(r.map((x) => x.total), 0.95),
    "ttft p50": pct(r.map((x) => x.ttft), 0.5),
    "valid tile": r.length ? `${r.filter((x) => x.valid).length}/${r.length}` : "-",
    "cached %": r.length ? Math.round((100 * r.reduce((s, x) => s + x.cached, 0)) / Math.max(1, r.reduce((s, x) => s + x.prompt, 0))) : NaN,
  };
  if (error) row.error = error;
  rows.push(row);
  process.stderr.write(`${model}: decision p50 ${row["decision p50"]}ms, valid ${row["valid tile"]}${error ? `  (${error})` : ""}\n`);
}
rows.sort((a, b) => (a["decision p50"] || Infinity) - (b["decision p50"] || Infinity));
console.log("times in ms; 'valid tile' = the target the model chose is a real floor tile");
console.table(rows);

// Glowmaze local server: the same game as the Vercel deployment, for development.
//
//  - Serves public/ and the two API routes (/api/decide, /api/config).
//  - The decision logic is shared with the Vercel function: lib/decide.js.
//  - Logs every decision to logs/decisions.jsonl and prints a rolling latency summary.
//  - Warns the page when prompt.js / shared.js changed since startup (restart needed).
//
// The Wafer key stays here; the browser never sees it. No dependencies.

import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, config } from "./lib/decide.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
loadDotEnv(join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const { key: KEY, model: MODEL, effort: EFFORT } = config();
const MAX_PER_MIN = Number(process.env.MAX_DECISIONS_PER_MIN || 1500); // spend guard
const LOG = join(ROOT, "logs", "decisions.jsonl");

// The server reads prompt.js and shared.js once at startup. If they change while it runs, the page
// (served fresh) and the AI's instructions drift apart, so the page is told to ask for a restart.
const SERVER_FILES = ["server.js", "prompt.js", "lib/decide.js", "public/shared.js"].map((f) => join(ROOT, f));
const codeSignature = () => SERVER_FILES.map((f) => statSync(f).mtimeMs).join(",");
const STARTED_WITH = codeSignature();

if (!KEY) {
  console.error("Missing WAFER_API_KEY. Copy .env.example to .env and add a key from https://app.wafer.ai");
  process.exit(1);
}

// ---------- metrics ----------
const recent = []; // recent decisions for the rolling console summary
let minuteCount = 0;
setInterval(() => (minuteCount = 0), 60_000).unref();
setInterval(() => {
  if (!recent.length) return;
  const batch = recent.splice(0); // everything since the last summary
  const ok = batch.filter((d) => d.ok);
  const p = (xs, q) => {
    const v = xs.filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(q * v.length))]) : "-";
  };
  console.log(
    `[last 5s] ${batch.length} decisions (${(batch.length / 5).toFixed(1)}/s) · ` +
      `latency p50 ${p(ok.map((d) => d.totalMs), 0.5)}ms p95 ${p(ok.map((d) => d.totalMs), 0.95)}ms · ` +
      `ttft p50 ${p(ok.map((d) => d.ttftMs), 0.5)}ms · errors ${batch.length - ok.length}`
  );
}, 5000).unref();

// ---------- server ----------
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "POST" && url.pathname === "/api/decide") return await handleDecide(req, res);
      if (req.method === "GET" && url.pathname === "/api/config")
        return json(res, 200, { model: MODEL, reasoningEffort: EFFORT, stale: codeSignature() !== STARTED_WITH });
      if (req.method === "GET") return await serveStatic(url.pathname, res);
      json(res, 405, { error: "method not allowed" });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
      else res.end();
    }
  })
  .listen(PORT, () => {
    console.log(`Glowmaze on http://localhost:${PORT}  (model ${MODEL}, reasoning ${EFFORT})`);
    console.log(`Every hunter decision is logged to logs/decisions.jsonl`);
  });

async function handleDecide(req, res) {
  const input = await readJson(req);
  if (++minuteCount > MAX_PER_MIN) return json(res, 429, { error: "local spend guard", retryAfter: 5 });
  const { status, body, record } = await decide({ hunterId: input.hunterId, state: input.state, epoch: input.epoch });
  recent.push({ at: Date.now(), ok: record.ok, totalMs: record.totalMs, ttftMs: record.ttftMs });
  mkdir(join(ROOT, "logs"), { recursive: true })
    .then(() => appendFile(LOG, JSON.stringify(record) + "\n"))
    .catch(() => {});
  json(res, status, body);
}

// ---------- plumbing ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, "public", rel);
  if (!file.startsWith(join(ROOT, "public")) || !existsSync(file)) return json(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

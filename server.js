// Glowmaze server.
//
//  - Serves the game.
//  - POST /api/decide: one hunter decision. Builds that hunter's prompt, calls Wafer chat
//    completions (streamed, JSON-schema output), times the call, and returns the decision.
//  - Logs every decision to logs/decisions.jsonl and prints a rolling latency summary.
//
// The Wafer key stays here; the browser never sees it. No dependencies.

import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { nearestFloor } from "./public/shared.js";
import { SYSTEM, SCHEMA } from "./prompt.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
loadDotEnv(join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.WAFER_API_KEY;
const BASE = (process.env.WAFER_BASE_URL || "https://pass.wafer.ai/v1").replace(/\/$/, "");
const MODEL = process.env.WAFER_MODEL || "GLM-5.3-Flash"; // the cheapest model in the catalog
const EFFORT = process.env.WAFER_REASONING_EFFORT || "none";
const MAX_PER_MIN = Number(process.env.MAX_DECISIONS_PER_MIN || 1500); // spend guard
const LOG = join(ROOT, "logs", "decisions.jsonl");

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
      if (req.method === "POST" && url.pathname === "/api/decide") return await decide(req, res);
      if (req.method === "GET" && url.pathname === "/api/config")
        return json(res, 200, { model: MODEL, reasoningEffort: EFFORT });
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

async function decide(req, res) {
  const { hunterId, state, epoch } = await readJson(req);
  if (!SYSTEM[hunterId]) return json(res, 400, { error: "unknown hunter" });
  if (++minuteCount > MAX_PER_MIN) return json(res, 429, { error: "local spend guard", retryAfter: 5 });

  const t0 = performance.now();
  const record = { ts: new Date().toISOString(), hunter: hunterId, epoch, model: MODEL, ok: false };
  let upstream;
  try {
    upstream = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        // Headroom: on GLM-5.3-Flash, reasoning_effort "none" can still spend hidden reasoning tokens,
        // which count toward max_tokens. Too low a cap truncates the JSON decision.
        max_tokens: 600,
        temperature: 0.6,
        reasoning_effort: EFFORT,
        response_format: SCHEMA,
        messages: [
          { role: "system", content: SYSTEM[hunterId] },
          { role: "user", content: JSON.stringify(state) },
        ],
      }),
    });
  } catch (err) {
    return finish(res, record, t0, 502, { error: `network: ${err.message}` });
  }

  if (!upstream.ok) {
    const body = await upstream.text();
    const retryAfter = Number(upstream.headers.get("retry-after")) || 1;
    let code = "";
    try {
      code = JSON.parse(body).error?.code || "";
    } catch {}
    return finish(res, record, t0, upstream.status, { error: `wafer ${upstream.status} ${code}`.trim(), retryAfter });
  }

  let ttft = null;
  let text = "";
  let usage = null;
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of upstream.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:") || line.endsWith("[DONE]")) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (evt.usage) usage = evt.usage;
      const piece = evt.choices?.[0]?.delta?.content;
      if (piece) {
        ttft ??= performance.now() - t0;
        text += piece;
      }
    }
  }

  record.ttftMs = ttft == null ? null : Math.round(ttft);
  record.promptTokens = usage?.prompt_tokens ?? null;
  record.cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? null;
  record.completionTokens = usage?.completion_tokens ?? null;

  let decision;
  try {
    decision = JSON.parse(text);
  } catch {
    record.raw = text.slice(0, 200);
    return finish(res, record, t0, 502, { error: "unparseable decision" });
  }
  const [col, row] = nearestFloor(Math.round(decision.col), Math.round(decision.row));
  const clean = {
    intent: String(decision.intent || "").slice(0, 60),
    col,
    row,
    radio: String(decision.radio || "").slice(0, 80),
  };
  record.ok = true;
  record.decision = clean;
  return finish(res, record, t0, 200, { decision: clean });
}

function finish(res, record, t0, status, body) {
  record.totalMs = Math.round(performance.now() - t0);
  record.status = status;
  if (!record.ok) record.error = body.error;
  recent.push({ at: Date.now(), ok: record.ok, totalMs: record.totalMs, ttftMs: record.ttftMs });
  mkdir(join(ROOT, "logs"), { recursive: true })
    .then(() => appendFile(LOG, JSON.stringify(record) + "\n"))
    .catch(() => {});
  json(res, status, {
    ...body,
    timing: {
      ttftMs: record.ttftMs ?? null,
      totalMs: record.totalMs,
      promptTokens: record.promptTokens ?? null,
      cachedTokens: record.cachedTokens ?? null,
      completionTokens: record.completionTokens ?? null,
    },
  });
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

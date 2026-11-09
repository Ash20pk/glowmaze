// One hunter decision: build the prompt, call Wafer (streamed, JSON-schema output), time it, and
// clean the result. Used by the local server (server.js) and the Vercel function (api/decide.js).

import { HUNTERS, nearestFloor } from "../public/shared.js";
import { SYSTEM, SCHEMA } from "../prompt.js";

const NAMES = Object.fromEntries(HUNTERS.map((h) => [h.id, h.name]));
const MAX_STATE_BYTES = 12_000; // a real snapshot is ~3KB

export function config(env = process.env) {
  return {
    key: env.WAFER_API_KEY,
    base: (env.WAFER_BASE_URL || "https://pass.wafer.ai/v1").replace(/\/$/, ""),
    model: env.WAFER_MODEL || "DeepSeek-V4-Flash-0731-Fast",
    effort: env.WAFER_REASONING_EFFORT || "none",
  };
}

/**
 * @returns {Promise<{ status: number, body: object, record: object }>}
 *   body is what the browser gets; record is the log line.
 */
export async function decide({ hunterId, state, epoch }, cfg = config(), fetchImpl = fetch) {
  const t0 = performance.now();
  const record = { ts: new Date().toISOString(), hunter: hunterId, epoch, model: cfg.model, ok: false };
  const done = (status, body) => finish(record, t0, status, body);

  if (!SYSTEM[hunterId]) return done(400, { error: "unknown hunter" });
  const stateJson = JSON.stringify(state ?? {});
  if (stateJson.length > MAX_STATE_BYTES) return done(413, { error: "state too large" });
  if (!cfg.key) return done(500, { error: "server is missing WAFER_API_KEY" });

  let upstream;
  try {
    upstream = await fetchImpl(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        // A decision is ~70 tokens. The headroom matters on models where reasoning_effort "none"
        // still spends hidden reasoning tokens (GLM-5.3-Flash), which would otherwise truncate the JSON.
        max_tokens: 300,
        temperature: 0.6,
        reasoning_effort: cfg.effort,
        response_format: SCHEMA,
        messages: [
          { role: "system", content: SYSTEM[hunterId] },
          { role: "user", content: stateJson },
        ],
      }),
    });
  } catch (err) {
    return done(502, { error: `network: ${err.message}` });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    let code = "";
    try {
      code = JSON.parse(text).error?.code || "";
    } catch {}
    // never pass Wafer's error body through: it can mention account details like the credit balance
    return done(upstream.status === 429 ? 429 : 502, {
      error: `wafer ${upstream.status} ${code}`.trim(),
      retryAfter: Number(upstream.headers.get("retry-after")) || 1,
    });
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
    return done(502, { error: "unparseable decision" });
  }
  const clean = cleanDecision(hunterId, decision);
  record.ok = true;
  record.decision = clean;
  return done(200, { decision: clean });
}

/** Clamp and sanitise a model decision. Exported for tests. */
export function cleanDecision(hunterId, d) {
  const [col, row] = nearestFloor(Math.round(d.col), Math.round(d.row));
  const usePower = d.usePower === true;
  return {
    intent: String(d.intent || "").slice(0, 60),
    col,
    row,
    // models sometimes sign their own messages ("Moth: ...") even when told not to; the UI shows who spoke
    radio: String(d.radio || "")
      .replace(new RegExp(`^\\s*${NAMES[hunterId]}\\s*(here)?\\s*[:,-]\\s*`, "i"), "")
      .slice(0, 80),
    orders: (Array.isArray(d.orders) ? d.orders : [])
      .slice(0, 4)
      .map((o) => ({ name: String(o?.name || "").slice(0, 12), junction: String(o?.junction || "").slice(0, 4) })),
    usePower,
    ...(usePower
      ? (([powerCol, powerRow]) => ({ powerCol, powerRow }))(nearestFloor(Math.round(d.powerCol), Math.round(d.powerRow)))
      : {}),
  };
}

function finish(record, t0, status, body) {
  record.totalMs = Math.round(performance.now() - t0);
  record.status = status;
  if (!record.ok) record.error = body.error;
  return {
    status,
    record,
    body: {
      ...body,
      timing: {
        ttftMs: record.ttftMs ?? null,
        totalMs: record.totalMs,
        promptTokens: record.promptTokens ?? null,
        cachedTokens: record.cachedTokens ?? null,
        completionTokens: record.completionTokens ?? null,
      },
    },
  };
}

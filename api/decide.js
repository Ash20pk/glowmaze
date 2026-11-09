// Vercel Function: one hunter decision. Same core as the local server (lib/decide.js), plus the
// public-endpoint guards in lib/guard.js. Each decision is logged as one JSON line to Vercel's logs.

import { decide } from "../lib/decide.js";
import { checkLimits, sameOrigin } from "../lib/guard.js";

const MAX_BODY_BYTES = 16_000;

export async function POST(request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!sameOrigin(request.headers.get("origin"), host)) return Response.json({ error: "forbidden" }, { status: 403 });

  const client = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const limit = checkLimits(client);
  if (!limit.ok) {
    return Response.json(
      { error: `rate limited: ${limit.reason}`, retryAfter: limit.retryAfter },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "request too large" }, { status: 413 });
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { status, body, record } = await decide({ hunterId: input.hunterId, state: input.state, epoch: input.epoch });
  console.log(JSON.stringify({ type: "decision", ...record }));
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

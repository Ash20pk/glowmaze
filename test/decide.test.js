import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, cleanDecision } from "../lib/decide.js";
import { checkLimits, sameOrigin } from "../lib/guard.js";
import { isOpen } from "../public/shared.js";

const cfg = { key: "test", base: "http://wafer.test/v1", model: "m", effort: "none" };
const sse = (obj) =>
  new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(obj) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200 }
  );

test("a streamed decision is parsed, cleaned and timed", async () => {
  const fake = async () => sse({ intent: "cut J3", col: 0, row: 0, radio: "Rook: wall up", usePower: true, powerCol: 5, powerRow: 5, orders: [{ name: "Vex", junction: "J3" }] });
  const r = await decide({ hunterId: "rook", state: { a: 1 } }, cfg, fake);
  assert.equal(r.status, 200);
  assert.ok(isOpen(r.body.decision.col, r.body.decision.row), "target snapped to floor");
  assert.equal(r.body.decision.radio, "wall up", "self-signature stripped");
  assert.deepEqual(r.body.decision.orders, [{ name: "Vex", junction: "J3" }]);
  assert.equal(r.body.timing.cachedTokens, 40);
});

test("unknown hunters, oversized state and a missing key are rejected before calling Wafer", async () => {
  let called = false;
  const fake = async () => ((called = true), sse({}));
  assert.equal((await decide({ hunterId: "nope", state: {} }, cfg, fake)).status, 400);
  assert.equal((await decide({ hunterId: "rook", state: { x: "a".repeat(20_000) } }, cfg, fake)).status, 413);
  assert.equal((await decide({ hunterId: "rook", state: {} }, { ...cfg, key: "" }, fake)).status, 500);
  assert.equal(called, false);
});

test("Wafer errors don't leak the upstream body", async () => {
  const fake = async () => new Response(JSON.stringify({ error: { code: "insufficient_credits", message: "balance $0.00" } }), { status: 402 });
  const r = await decide({ hunterId: "vex", state: {} }, cfg, fake);
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.body).includes("balance"));
});

test("cleanDecision drops power target when power is not used", () => {
  const d = cleanDecision("pip", { intent: "x", col: 1, row: 1, radio: "", usePower: false, powerCol: 3, powerRow: 3 });
  assert.equal(d.powerCol, undefined);
});

test("rate limiter allows a burst then throttles", () => {
  const now = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (checkLimits("1.2.3.4", now).ok) allowed++;
  assert.equal(allowed, 30);
  assert.ok(checkLimits("1.2.3.4", now + 1000).ok, "refills over time");
});

test("same-origin check", () => {
  assert.ok(sameOrigin(undefined, "glowmaze.vercel.app"));
  assert.ok(sameOrigin("https://glowmaze.vercel.app", "glowmaze.vercel.app"));
  assert.ok(!sameOrigin("https://evil.example", "glowmaze.vercel.app"));
});

// A stand-in for Wafer's /v1/chat/completions, for working on the game without an API key or spend.
// It plays a simple hand-written strategy per hunter and streams the JSON back like Wafer does.
// The decisions are NOT from a model; use this for development only.
//
//   node scripts/mock-wafer.js            # listens on :4999
//   WAFER_BASE_URL=http://localhost:4999/v1 WAFER_API_KEY=mock npm start

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 4999);
const LATENCY = [180, 320]; // ms, uniformly random
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http
  .createServer(async (req, res) => {
    if (!req.url.endsWith("/chat/completions")) return res.writeHead(404).end();
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const who = body.messages[0].content.match(/You control (\w+)\.$/m)?.[1] ?? "Rook";
    const s = JSON.parse(body.messages[1].content);
    const pick = {
      Rook: s.player.in3Tiles,
      Vex: s.player.in6Tiles,
      Moth: s.sparks.nearestToPlayer ?? s.player.at,
      Grim: s.player.at,
      Pip: [36 - s.player.at[0], s.player.at[1]],
    }[who] ?? s.player.at;
    const decision = {
      intent: { Rook: "press the player", Vex: "cut off ahead", Moth: "guard the sparks", Grim: "herd from behind", Pip: "cover the mirror lane" }[who],
      col: pick[0],
      row: pick[1],
      radio: Math.random() < 0.12 ? `${who} here, moving to ${pick[0]},${pick[1]}` : "",
    };
    const text = JSON.stringify(decision);
    const total = LATENCY[0] + Math.random() * (LATENCY[1] - LATENCY[0]);
    await sleep(total * 0.6);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (let i = 0; i < text.length; i += 12) {
      send({ choices: [{ index: 0, delta: { content: text.slice(i, i + 12) } }] });
      await sleep((total * 0.4) / Math.ceil(text.length / 12));
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({ choices: [], usage: { prompt_tokens: 1450, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1100 } } });
    res.end("data: [DONE]\n\n");
  })
  .listen(PORT, () => console.log(`mock Wafer on http://localhost:${PORT}/v1 (not a model)`));

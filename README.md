# Glowmaze

A neon maze-chase arcade game where all five hunters are controlled live by an LLM running on [Wafer](https://wafer.ai). They plan, predict where you're going and talk to each other on a team radio to trap you.

https://github.com/user-attachments/assets/REPLACE-WITH-DEMO-VIDEO

The game includes a **lag switch**. Press `L` and every AI decision arrives 2 seconds later. The hunters start chasing where you *used to be*, and you walk away. Press it again and they close in. That's the point of the demo: **in a real-time app, inference latency is your product's reaction time.**

## Quickstart

You need Node 18 or newer. There are no dependencies and no build step.

```bash
git clone <this repo> && cd glowmaze
cp .env.example .env      # add your key from https://app.wafer.ai
npm start                 # → http://localhost:3000
```

Press **Enter** to play.

| Key | Does |
| - | - |
| Arrows / WASD | Move |
| Space | Pulse: stuns hunters within 5 tiles for 3s. Collect the corner orbs for more |
| L | Toggle 2s of extra inference lag |
| T | Show or hide each hunter's current plan (the dashed line to its target) |
| P | Pause. The AI stops calling Wafer while paused or when the tab is hidden |

## How it works

No LLM can steer a character 60 times a second, and it shouldn't try. Glowmaze splits the work the way real-time AI apps have to:

```
 browser, 60fps                                 server                     Wafer
 ┌──────────────────────────────┐   snapshot   ┌──────────────┐  stream   ┌──────────────────┐
 │ movement · collisions ·      │ ───────────► │ hunter prompt│ ────────► │ chat completions │
 │ pathfinding                  │              │ + JSON schema│ ◄──────── │ (JSON output)    │
 │                              │ ◄─────────── │ timing, log  │           └──────────────────┘
 │ hunter walks to its target   │   decision   └──────────────┘
 └──────────────────────────────┘   {intent, col, row, radio}
```

- **Each hunter has its own async "brain" loop.** It takes a snapshot of the game: its position, your position and heading, where you'll be in 3 and 6 tiles, teammates' positions and intents, the last few radio lines, and where the sparks are left. It asks Wafer for a decision, applies it, and repeats. Five hunters make about 15–20 decisions per second between them.
- **The model decides; ordinary code moves.** A decision is a target tile, a short intent and an optional radio line. Breadth-first pathfinding walks the hunter there along the shortest route until the next decision arrives.
- **Personalities come from the prompt alone.** Rook presses you, Vex intercepts, Moth guards the sparks, Grim herds you toward the others, and Pip fills the gaps. There's no hand-coded strategy.
- **Decisions are made from a snapshot, so latency matters.** Everything moves while the request is in flight. At ~250ms the snapshot is still accurate when the decision lands. At 2s, you're 12 tiles away from it.

### Details worth stealing

- **Structured output.** The response uses `response_format: json_schema` with `strict: true`, so every reply parses and the game never stalls on malformed text. The target is also snapped to the nearest floor tile, in case the model picks a wall.
- **Prompt caching by design.** The system prompt (the maze, rules and persona) never changes for a given hunter, and only the small JSON state in the user message does. Wafer's prompt cache reuses the static prefix, and the HUD shows the cached share live.
- **Reasoning off.** `reasoning_effort: "none"`. A hunter needs a fast, good-enough decision, not a long thought.
- **Stale decisions are dropped.** Every life increments an `epoch`. A decision that comes back after you were caught is ignored rather than applied to the new round.
- **Backpressure.** Wafer sheds load with `429` and `Retry-After` instead of queueing. A brain loop that gets one waits as instructed, keeps its old target, and shows the error in the HUD. Nothing is hidden.

## Reading the HUD

| Stat | Meaning |
| - | - |
| **AI reaction p50** | Snapshot taken → decision applied, including any lag you added. This is what the player feels |
| **Wafer latency p50 / p95** | The Wafer call on its own, measured on the server, from request sent to the last token of the decision |
| **First token p50** | Time to the first streamed token |
| **Decisions / sec** | Across all five hunters |
| **Prompt cached** | Share of prompt tokens served from Wafer's prompt cache |
| **Errors (10s)** | Failed or shed decisions |

Stats cover a rolling 10-second window and reset when you toggle the lag switch, so each mode shows only its own numbers. Each hunter's row shows its current intent and its last reaction time.

The server prints a summary every 5 seconds:

```
[last 5s] 88 decisions (17.6/s) · latency p50 260ms p95 433ms · ttft p50 155ms · errors 0
```

It also writes every decision to `logs/decisions.jsonl`, with timings, token counts, cached tokens, status and the decision itself:

```bash
jq -s 'map(select(.ok) | .totalMs) | sort | .[length/2|floor]' logs/decisions.jsonl   # median decision latency
```

## Choosing a model

`npm run bench` sends the game's real hunter prompt and a realistic game state to every model in Wafer's catalog. It measures what the game cares about: time to a complete decision (the hunter can't act on half a JSON object), time to first token, the cache hit rate, and how often the chosen target is a real floor tile.

```bash
npm run bench                                  # whole catalog, 8 runs each
npm run bench -- GLM-5.3-Flash DeepSeek-V4-Flash-0731-Fast --runs 20
```

The default is **GLM-5.3-Flash**, the cheapest model in Wafer's catalog ($0.05 per million input tokens, $0.03 cached, $0.20 output). Input is almost all of this game's spend, so it's cheapest by a wide margin. Wafer's docs note that on this model `reasoning_effort: "none"` doesn't fully stop hidden reasoning, so the server leaves `max_tokens` at 600 to keep the JSON decision from being cut off.

## Configuration

| Variable | Default | |
| - | - | - |
| `WAFER_API_KEY` | (required) | From [app.wafer.ai](https://app.wafer.ai) |
| `WAFER_MODEL` | `GLM-5.3-Flash` | Any ID from `GET https://pass.wafer.ai/v1/models` |
| `WAFER_REASONING_EFFORT` | `none` | |
| `MAX_DECISIONS_PER_MIN` | `1500` | Local spend guard. Requests beyond it are refused before they reach Wafer |
| `PORT` | `3000` | |

URL parameters for tuning: `?hs=6.0` sets hunter speed and `?ps=6.4` sets your speed, both in tiles per second.

**Cost.** Each decision is about 1,000 prompt tokens, mostly cached, plus about 30 output tokens. At around 1,000 decisions a minute on GLM-5.3-Flash, play costs roughly 3–6 cents a minute. The AI only runs while a round is in progress.

## Developing without a key

```bash
npm run mock        # terminal 1: a stand-in for Wafer on :4999
npm run dev:mock    # terminal 2: the game, pointed at the mock
```

The mock streams responses in Wafer's format with 180–320ms of fake latency, but its decisions come from a **hand-written heuristic, not a model**. Use it to work on the game, never to quote numbers. Add `?autopilot&autostart` to the URL and a simple bot plays for you.

## Project layout

```
server.js              serves the game, calls Wafer per decision, logs timings
prompt.js              hunter system prompts + JSON schema (shared with the bench)
public/shared.js       maze, hunter personalities, pathfinding (browser + server)
public/game.js         game loop, AI brain loops, rendering, HUD, lag switch
public/index.html      page
public/style.css       styles
scripts/bench.js       decision-latency benchmark across Wafer models
scripts/mock-wafer.js  offline stand-in for development
```

## License

MIT

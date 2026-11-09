# Glowmaze

A neon maze-chase arcade game where all five hunters are controlled live by an LLM running on [Wafer](https://wafer.ai). They can only see you down a straight corridor, so they have to **find** you: they share sightings on a team radio, split up to search where you could have gone, and claim escape routes to trap you. Each hunter also has a power that bends the map, and the AI decides when and where to use it.

https://github.com/user-attachments/assets/REPLACE-WITH-DEMO-VIDEO

The game includes a **lag switch**. Press `L` and every AI decision arrives 2 seconds later. The hunters start chasing where you *used to be*, and you walk away. Press it again and they close in. That's the point of the demo: **in a real-time app, inference latency is your product's reaction time.**

## Quickstart

You need Node 18 or newer. There are no dependencies and no build step.

```bash
git clone <this repo> && cd glowmaze
cp .env.example .env      # add your key from https://app.wafer.ai
npm start                 # → http://localhost:3000
```

A five-screen guide explains the game before the first round (Esc skips it, H brings it back).

| Key | Does |
| - | - |
| Arrows / WASD | Move |
| Space | Pulse: stuns hunters within 5 tiles for 3s and breaks their walls, sludge and snares nearby. Collect the purple orbs for more |
| L | Toggle 2s of extra inference lag |
| T | Show or hide each hunter's current plan (the dashed line to its target) |
| F | Fullscreen |
| P | Pause. The AI stops calling Wafer while paused or when the tab is hidden |
| H | How to play |

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

- **Each hunter has its own async "brain" loop.** It takes a snapshot of what the team knows, asks Wafer for a decision, applies it, and repeats. Each hunter decides about every 800ms, so five hunters make about 6 decisions per second between them.
- **The model decides; ordinary code moves.** A decision is a target tile, a short intent and an optional radio line. Breadth-first pathfinding walks the hunter there along the shortest route until the next decision arrives.
- **Personalities come from the prompt alone.** Rook presses you, Vex intercepts, Moth guards the sparks, Grim herds you toward the others, and Pip fills the gaps. There's no hand-coded strategy.
- **Decisions are made from a snapshot, so latency matters.** Everything moves while the request is in flight. At ~800ms you've moved about 5 tiles by the time a decision lands, which is close enough for the hunters' predictions to cover it. Add 2s and you're 18 tiles away, and powers land late too: Rook's wall drops where you were.

### Fog of war: they have to find you

Hunters see you only down a straight, unbroken corridor, or when they're right next to you. Every sighting is shared with the whole team. When nobody can see you, the hunters only know where you were last seen and which way you were heading. On screen:

- A coloured **sight line** means a hunter can see you, and a **!** appears when one spots you.
- A red **?** marks the team's last sighting.
- The badge in the corner reads **SPOTTED · Vex** or **HIDDEN 4.2s**.

### Five hunters, five powers

| Hunter | Power | Effect | Cooldown |
| - | - | - | - |
| Rook | Wall Slam | A wall seals one corridor tile for 6s | 15s |
| Vex | Blink | Teleports to any tile at least 5 tiles from you | 20s |
| Moth | Flare | Lights a 6-tile radius for 5s; inside it you're visible to the whole team | 15s |
| Grim | Sludge | Up to 5 tiles of corridor at half speed for you, for 6s | 15s |
| Pip | Snare | A hidden trap for 20s; stepping on it freezes you for 1.5s and reveals you | 20s |

The model decides when and where to use a power (`usePower`, `powerCol`, `powerRow` in its JSON reply). If a power has been ready for 1.5s and the model hasn't used it, the game fires it automatically at a target picked by simple rules: an escape junction ahead of you, the corridor you're running down, or the most likely hiding spot. That target comes from the same snapshot the hunter's decision was based on, so automatic powers are just as late as everything else when the lag switch is on. The HUD labels them "(auto)". In testing, the model chose 11 of 12 powers itself. Every decision includes whether the hunter's power is ready, the teammates' power status, and the active effects, so hunters set up combos on the radio ("Wall at J39, Vex blink there too").

**The rules are enforced in code, not trusted to the model.**
- A wall can't land within 3 tiles of you, on anyone, or anywhere that would cut you off from most of the maze.
- Blink can't land within 5 tiles of you.
- A snare can't be placed within 4 tiles of you, and Pip can have at most two set.
- Every power flashes in the hunter's colour for 0.5s before it lands, and its legality is checked again when it fires.
- An illegal request is rejected and nothing fires. A power that becomes illegal during its warning (say you stepped next to the wall tile) fizzles, and its cooldown is spent. The hunter's row in the HUD shows the reason, and the hunter is told on its next turn.

### Code calculates, the model decides

Language models are poor at spatial arithmetic over an ASCII grid, so `public/tactics.js` does the geometry and the prompt carries the results:

- **Named junctions.** The 54 tiles with three or more exits are labelled `J1`–`J54`, so the model can reason and talk about places ("Pip, take J37").
- **When you're visible:** `escapes`, the next junction down each route out of your position. For each one it gives your distance, this hunter's distance, whether the hunter gets there first, and the closest teammate. The model's job is to claim one, not to measure.
- **When you're hidden:** `candidates`, the junctions you could have reached since the last sighting. They're ranked by whether they lie along your last heading, whether they sit near the edge of the distance you could have covered, and whether any hunter has looked there since.

The result is visible on the radio. Hunters claim and divide routes ("Moth: taking J40, Rook holds J41"), and when they lose you they spread across the likely candidates instead of all running to the last sighting.

### Details worth stealing

- **Structured output.** The response uses `response_format: json_schema` with `strict: true`, so every reply parses and the game never stalls on malformed text. The target is also snapped to the nearest floor tile, in case the model picks a wall.
- **A cache-friendly prompt.** The system prompt never changes. The maze, rules and output format come first and are identical for all five hunters, the persona comes last, and only the small JSON state in the user message varies. The HUD shows how much of the prompt Wafer served from its cache. In our runs that was about 40% during play.
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
npm run bench -- DeepSeek-V4-Flash-0731-Fast GLM-5.3-Flash --runs 20
```

The default is **DeepSeek-V4-Flash-0731-Fast**, which Wafer serves for high throughput. We started on GLM-5.3-Flash, the cheapest model in the catalog, and measured both in real play on 9 November 2026:

| | DeepSeek-V4-Flash-0731-Fast | GLM-5.3-Flash |
| - | - | - |
| Decision latency p50 | **~670ms** | 1,000–2,300ms |
| Decision latency p95 | ~1,000ms | 3,000–6,000ms |
| First token p50 | ~390ms | 400–2,200ms |
| Output tokens per decision | ~38 (max 59) | ~46 (max 313) |
| Decisions/sec, 5 hunters | ~7 | 2–3 |

These were measured on an earlier, smaller 21×19 maze. On the current 37×23 maze, with fog of war and the tactics data, the prompt is about 1,300 tokens and DeepSeek's decisions take about 650ms p50 and 1,400ms p95. Adding powers roughly doubled the output (about 70 tokens per decision), which brings that to about 800ms p50 and 1,200ms p95.

GLM-5.3-Flash costs less per token, but it was slower. Some decisions spent around 250 hidden reasoning tokens, a [documented quirk](https://docs.wafer.ai/serverless/chat-completions.md#reasoning): `reasoning_effort: "none"` doesn't fully stop reasoning on that model. At 1–2 seconds per decision, the hunters were already as slow as the lag switch is meant to make them. For a real-time app, the model with the fastest serving beats the cheapest one.

## Configuration

| Variable | Default | |
| - | - | - |
| `WAFER_API_KEY` | (required) | From [app.wafer.ai](https://app.wafer.ai) |
| `WAFER_MODEL` | `DeepSeek-V4-Flash-0731-Fast` | Any ID from `GET https://pass.wafer.ai/v1/models` |
| `WAFER_REASONING_EFFORT` | `none` | |
| `MAX_DECISIONS_PER_MIN` | `1500` | Local spend guard. Requests beyond it are refused before they reach Wafer |
| `PORT` | `3000` | |

URL parameters for tuning: `?hs=6.0` sets hunter speed and `?ps=6.4` sets your speed, both in tiles per second.

**Cost.** Each decision is about 1,400 prompt tokens (around 40% cached) and 70 output tokens. At about 340 decisions a minute on the default model, play costs roughly 4–6 cents a minute. The AI only runs while a round is in progress.

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
public/tactics.js      junctions, line of sight, escape routes, search candidates
public/onboarding.js   the how-to-play screens
public/game.js         game loop, AI brain loops, rendering, HUD, lag switch
public/index.html      page
public/style.css       styles
scripts/bench.js       decision-latency benchmark across Wafer models
scripts/mock-wafer.js  offline stand-in for development
```

## License

MIT

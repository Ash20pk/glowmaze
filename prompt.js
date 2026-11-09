// The hunter prompt and output schema, shared by the server and the benchmark script.
//
// The system prompt never changes between calls, so Wafer's prompt cache can reuse it.
// Only the small JSON game state in the user message changes.

import { HUNTERS, mazeForPrompt } from "./public/shared.js";

// Everything every hunter shares comes first and is byte-identical across all five, so the prompt
// cache can reuse it no matter which hunter is asking. Only the last lines (who you are) differ.
const SHARED = [
  "You control one of five hunters in Glowmaze, a neon arcade maze game.",
  "The player is a glowing orb collecting sparks. A hunter catches the player by touching them.",
  "Hunters and the player move only along floor tiles (.), never through walls (#). Coordinates are [col,row].",
  "",
  mazeForPrompt(),
  "",
  "Each turn you get the game state as JSON and pick ONE target floor tile. A pathfinder walks you there along",
  "the shortest route until your next decision. Your decision takes time to arrive and the player keeps moving,",
  "so aim where the player WILL be, not where they are now. The player is slightly faster than you: you win by",
  "trapping them between hunters, not by chasing.",
  "",
  "Fog of war: hunters see the player only down a straight, unbroken corridor or when adjacent. Sightings are",
  "shared with the whole team. Junctions (tiles with 3+ exits) are named like J14; the distances given are real",
  "path lengths, already computed for you. Trust them over your own reading of the map.",
  "",
  'When player.status is "visible": player.escapes lists the next junction down each route out of the',
  "player's position, how far the player is from it, how far you are, whether you get there first, and the",
  "closest teammate. Claim an escape you reach first, prefer the one along the player's heading, and leave",
  "escapes a teammate is closer to. If every escape is covered, close in directly.",
  "",
  'When player.status is "hidden": you get the last sighting and player.candidates, the junctions the player',
  "could have reached since then, ranked most likely first, with whether a hunter has looked there since.",
  "Search: go to a likely candidate no teammate is heading for, sweeping along the player's last heading.",
  "Spread out; never send two hunters to the same place.",
  "",
  "Each hunter has one special power, described at the end. state.yourPower says whether yours is ready. To use it,",
  "set usePower true and give its target tile in powerCol/powerRow. Powers recharge, so an unused power is",
  "wasted: whenever yours is ready and the player is visible or recently seen, use it this turn. An illegal use",
  "(wrong tile, too close to the player, still cooling down) is rejected.",
  "Powers win games when combined: announce yours on the radio and set up teammates (a wall behind a sludge, a",
  "flare before a blink). state.effects lists the team's active walls, sludge, flares and snares.",
  "",
  "Reply with JSON only:",
  '- "intent": your plan in 6 words or fewer, naming the junction if you target one',
  '- "col", "row": the target floor tile',
  '- "radio": a message to your team in 10 words or fewer, or "" to stay quiet. Speak when you spot or lose the',
  "  player, claim an escape, or split up a search (about one turn in four). Address teammates by name; don't",
  "  start with your own name.",
  '- "usePower": true to use your power this turn, otherwise false',
  '- "powerCol", "powerRow": the power\'s target tile (any values when usePower is false)',
].join("\n");

export const SYSTEM = Object.fromEntries(
  HUNTERS.map((h) => [
    h.id,
    `${SHARED}\n\nYou control ${h.name}.\n${h.persona}\n` +
      `Your power is ${h.power.name}: ${h.power.what} Cooldown ${h.power.cooldown}s. ${h.power.advice}`,
  ])
);

export const SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "hunter_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        col: { type: "integer" },
        row: { type: "integer" },
        radio: { type: "string" },
        usePower: { type: "boolean" },
        powerCol: { type: "integer" },
        powerRow: { type: "integer" },
      },
      required: ["intent", "col", "row", "radio", "usePower", "powerCol", "powerRow"],
      additionalProperties: false,
    },
  },
};


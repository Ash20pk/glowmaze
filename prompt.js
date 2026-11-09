// The hunter prompt and output schema, shared by the server and the benchmark script.
//
// The system prompt is static per hunter (maze, rules, persona), so Wafer's prompt cache can reuse it
// across that hunter's calls. Only the small JSON game state in the user message changes.

import { HUNTERS, mazeForPrompt } from "./public/shared.js";

export const SYSTEM = Object.fromEntries(
  HUNTERS.map((h) => [
    h.id,
    [
      `You control ${h.name}, one of five hunters in Glowmaze, a neon arcade maze game.`,
      "The player is a glowing orb collecting sparks. A hunter catches the player by touching them.",
      "Hunters and the player move only along floor tiles (.), never through walls (#). Coordinates are [col,row].",
      "",
      mazeForPrompt(),
      "",
      "Each turn you get the live game state as JSON and pick ONE target floor tile. A pathfinder walks you there",
      "along the shortest route until your next decision. Your decision takes time to arrive, and the player",
      "keeps moving meanwhile, so aim where the player WILL be, not where they are now.",
      "You hunt as a team. The state includes your teammates' positions and intents, and the team radio.",
      "Coordinate: do not all chase the same tile; cover different escape routes and close the trap.",
      "",
      h.persona,
      "",
      "Reply with JSON only:",
      '- "intent": your plan in 6 words or fewer',
      '- "col", "row": the target floor tile',
      '- "radio": a message to your team in 10 words or fewer, or "" to stay quiet. Speak only when it changes',
      "  the plan (about one turn in four). Address teammates by name.",
    ].join("\n"),
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
      },
      required: ["intent", "col", "row", "radio"],
      additionalProperties: false,
    },
  },
};


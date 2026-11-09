// Vercel Function: which model the hunters run on, for the page header.
import { config } from "../lib/decide.js";

export function GET() {
  const { model, effort } = config();
  return Response.json({ model, reasoningEffort: effort, stale: false }, { headers: { "Cache-Control": "no-store" } });
}

import { NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-handler";
import { checkOllama } from "@/lib/ollama-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ai/status
 *
 * Reports whether the local Ollama service is reachable and which model would be used. It answers
 * 200 even when Ollama is down ({ available: false, reason, message, steps }) so the page can show
 * a friendly setup panel instead of an error.
 */
export const GET = withApiHandler(async () => {
  const status = await checkOllama();
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
});

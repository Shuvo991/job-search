import { NextResponse } from "next/server";
import { toErrorResponse, withApiHandler, type ApiErrorBody } from "@/lib/api-handler";
import { NotFoundError } from "@/lib/errors";
import { getJobById } from "@/lib/jobs/repository";
import { tailorCv } from "@/lib/tailoring/service";
import type { TailorStreamEvent } from "@/lib/tailoring/types";
import { parseJsonBody } from "@/lib/validation";
import { tailorRequestSchema } from "@/schemas/tailoring";

// Reads config/prompts from disk, talks to a local service, and handles a private document.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NDJSON = "application/x-ndjson";

/**
 * POST /api/documents/tailor-cv   { jobId, resumeText, model? }
 *
 * Reads the CV with the local model, then rewrites each bullet with it, one small call at a time, and
 * returns a REVIEW DRAFT (original vs tailored text, guardrail flags, warnings). Nothing is stored.
 *
 * Plain request:  200 { draft, warnings, meta }
 * With `Accept: application/x-ndjson`: 200 and one JSON object per line while it works:
 *   {"type":"progress",...} ... then {"type":"result","result":{draft,warnings,meta}}
 *   or {"type":"error","error":{code,message,details}} (the same error shape as below).
 * Failures that happen before any work starts (validation, unknown job) are ordinary JSON errors:
 * 400 validation | 404 no such job | 422 CV too short or too long
 * Failures during the work: 503 Ollama not running / model not installed | 504 model too slow | 502 unusable output
 */
export const POST = withApiHandler(async (req, _ctx, meta) => {
  const body = await parseJsonBody(req, tailorRequestSchema);
  const job = await getJobById(body.jobId);
  if (!job) throw new NotFoundError("Job not found");

  if (!(req.headers.get("accept") ?? "").includes(NDJSON)) {
    const result = await tailorCv({ job, resumeText: body.resumeText, model: body.model, signal: req.signal });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  }

  const encoder = new TextEncoder();
  const stop = new AbortController();
  const signal = AbortSignal.any([req.signal, stop.signal]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: TailorStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false; // the browser went away; the abort signal stops the work
        }
      };
      try {
        const result = await tailorCv({
          job,
          resumeText: body.resumeText,
          model: body.model,
          signal,
          onProgress: (progress) => send({ type: "progress", ...progress }),
        });
        send({ type: "result", result });
      } catch (err) {
        // Same normalising and logging as every other route, then the error travels as the last line.
        const failure = (await toErrorResponse(err, meta.requestId).json()) as ApiErrorBody;
        send({ type: "error", error: failure.error });
      } finally {
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": `${NDJSON}; charset=utf-8`, "cache-control": "no-store" },
  });
});

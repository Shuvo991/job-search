import { NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-handler";
import { NotFoundError } from "@/lib/errors";
import { getJobById } from "@/lib/jobs/repository";
import { writeCoverLetter } from "@/lib/tailoring/service";
import { parseJsonBody } from "@/lib/validation";
import { tailorRequestSchema } from "@/schemas/tailoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/documents/cover-letter   { jobId, resumeText, model? }
 *
 * Runs the cover letter prompt on the local model and returns a REVIEW DRAFT: editable paragraphs,
 * the CV lines that back each one, guardrail flags and warnings. Nothing is stored.
 * Same status codes as POST /api/documents/tailor-cv.
 */
export const POST = withApiHandler(async (req) => {
  const body = await parseJsonBody(req, tailorRequestSchema);
  const job = await getJobById(body.jobId);
  if (!job) throw new NotFoundError("Job not found");

  const result = await writeCoverLetter({ job, resumeText: body.resumeText, model: body.model, signal: req.signal });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
});

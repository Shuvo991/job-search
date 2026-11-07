import { NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-handler";
import { buildJobFromRequest } from "@/lib/jobs/build-job";
import { createJob, listJobs } from "@/lib/jobs/repository";
import { parseJobsSearchParams } from "@/lib/jobs/search-params";
import { parseJsonBody } from "@/lib/validation";
import { addJobRequestSchema } from "@/schemas/job-input";

export const dynamic = "force-dynamic";

/** Pasted descriptions can be large; 2 MiB covers the 200k-character cap with JSON escaping. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/jobs?q=&roleCategory=&workMode=&seniority=&sector=&location=&skill=React&skill=SQL&page=&pageSize=
 */
export const GET = withApiHandler(async (req) => {
  const query = parseJobsSearchParams(new URL(req.url).searchParams);
  return NextResponse.json(await listJobs(query), { headers: { "cache-control": "no-store" } });
});

/**
 * POST /api/jobs  (Content-Type: application/json)
 *   { "mode": "structured", title, company, roleCategory, description, ... }
 *   { "mode": "raw", title, company, text, url?, roleCategory?, location? }
 */
export const POST = withApiHandler(async (req) => {
  const body = await parseJsonBody(req, addJobRequestSchema, { maxBytes: MAX_BODY_BYTES });
  const job = await createJob(buildJobFromRequest(body));
  return NextResponse.json(
    { job },
    { status: 201, headers: { location: `/jobs/${job.id}`, "cache-control": "no-store" } },
  );
});

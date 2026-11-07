import { z } from "zod";
import { EMPLOYMENT_TYPES, ROLE_CATEGORIES, SECTORS, SENIORITIES, WORK_MODES } from "@/schemas/enums";

/**
 * Request body for POST /api/jobs.
 *
 * These schemas only bound the SIZE and SHAPE of untrusted input. Sanitising (HTML -> plain text),
 * skill extraction and inference happen afterwards in src/lib/jobs/build-job.ts, and the result is
 * validated again by createJobSchema before anything is stored.
 */

/** Pasted text is bounded before sanitising; markup-heavy pages are much larger than their text. */
export const RAW_TEXT_MAX_CHARS = 200_000;

const optionalText = (max: number) => z.string().max(max).optional();

const structuredJobSchema = z.object({
  mode: z.literal("structured"),
  title: z.string().max(400),
  company: z.string().max(400),
  location: optionalText(400),
  country: optionalText(200),
  roleCategory: z.enum(ROLE_CATEGORIES),
  sector: z.enum(SECTORS).default("TECH"),
  workMode: z.enum(WORK_MODES).default("UNKNOWN"),
  seniority: z.enum(SENIORITIES).default("UNKNOWN"),
  employmentType: z.enum(EMPLOYMENT_TYPES).default("UNKNOWN"),
  description: z.string().max(RAW_TEXT_MAX_CHARS),
  /** Leave empty to auto-detect from the description. */
  skills: z.array(z.string().max(200)).max(200).default([]),
  salaryMin: z.number().int().nonnegative().max(100_000_000).optional(),
  salaryMax: z.number().int().nonnegative().max(100_000_000).optional(),
  salaryCurrency: optionalText(10),
  applyUrl: optionalText(2048),
});

const rawJobSchema = z.object({
  mode: z.literal("raw"),
  title: z.string().max(400),
  company: z.string().max(400),
  location: optionalText(400),
  /** Omit to detect the role from the title. */
  roleCategory: z.enum(ROLE_CATEGORIES).optional(),
  /** The pasted description: plain text or HTML. */
  text: z.string().max(RAW_TEXT_MAX_CHARS),
  /** Link to the original posting (optional). It is stored, never fetched. */
  url: optionalText(2048),
});

export const addJobRequestSchema = z.discriminatedUnion("mode", [structuredJobSchema, rawJobSchema]);

export type AddJobRequest = z.infer<typeof addJobRequestSchema>;
export type StructuredJobRequest = z.infer<typeof structuredJobSchema>;
export type RawJobRequest = z.infer<typeof rawJobSchema>;

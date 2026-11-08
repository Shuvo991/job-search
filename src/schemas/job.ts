import { z } from "zod";
import { httpUrlSchema, longText, paginationSchema, queryBooleanSchema, shortText } from "@/schemas/common";
import {
  EMPLOYMENT_TYPES,
  ROLE_CATEGORIES,
  SECTORS,
  SENIORITIES,
  WORK_MODES,
} from "@/schemas/enums";

export const createJobSchema = z
  .object({
    title: shortText(200),
    company: shortText(200),
    location: shortText(200).optional(),
    country: shortText(100).optional(),
    roleCategory: z.enum(ROLE_CATEGORIES),
    sector: z.enum(SECTORS).default("TECH"),
    workMode: z.enum(WORK_MODES).default("UNKNOWN"),
    seniority: z.enum(SENIORITIES).default("UNKNOWN"),
    employmentType: z.enum(EMPLOYMENT_TYPES).default("UNKNOWN"),
    description: longText(100_000),
    skills: z.array(shortText(60)).max(100).default([]),
    requirements: z.array(shortText(500)).max(100).default([]),
    salaryMin: z.number().int().nonnegative().optional(),
    salaryMax: z.number().int().nonnegative().optional(),
    salaryCurrency: z.string().trim().length(3).toUpperCase().optional(),
    sourceName: shortText(100),
    sourceUrl: httpUrlSchema.optional(),
    applyUrl: httpUrlSchema.optional(),
    /** Credit line the job's source requires us to show (set for imported jobs only). */
    attribution: shortText(300).optional(),
    externalId: shortText(200).optional(),
    postedAt: z.coerce.date().optional(),
  })
  .refine((job) => job.salaryMin === undefined || job.salaryMax === undefined || job.salaryMin <= job.salaryMax, {
    message: "salaryMin must be less than or equal to salaryMax",
    path: ["salaryMin"],
  });

export const listJobsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  roleCategory: z.enum(ROLE_CATEGORIES).optional(),
  sector: z.enum(SECTORS).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  seniority: z.enum(SENIORITIES).optional(),
  /** Substring match on the job's location or country. */
  location: z.string().trim().max(100).optional(),
  /** A country (or "Europe" / "Worldwide"), as listed in the board's Country filter. */
  country: z.string().trim().max(60).optional(),
  /** A city of that country, as listed in the board's City filter. */
  city: z.string().trim().max(60).optional(),
  /** A job must contain ALL of these skills (case-insensitive). */
  skills: z.array(shortText(60)).max(10).default([]),
  isActive: queryBooleanSchema.optional(),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

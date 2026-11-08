/**
 * Database access for jobs. All queries go through Prisma (parameterized); there is no raw SQL.
 *
 * SQLite notes:
 *  - `contains` compiles to LIKE, which is case-insensitive for ASCII only.
 *  - `skills` is a JSON column and SQLite JSON filtering is not available through Prisma, so the
 *    skills filter runs in application code on the rows that already match every other filter.
 *    That is fine for a local board (thousands of rows); revisit with a join table if it grows.
 */
import type { Job as JobRow, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { computeDedupeHash } from "@/lib/jobs/dedupe";
import type { CreateJobInput, ListJobsQuery } from "@/schemas/job";

export interface JobView {
  id: string;
  title: string;
  company: string;
  location: string | null;
  country: string | null;
  roleCategory: JobRow["roleCategory"];
  sector: JobRow["sector"];
  workMode: JobRow["workMode"];
  seniority: JobRow["seniority"];
  employmentType: JobRow["employmentType"];
  description: string;
  skills: string[];
  requirements: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  sourceName: string;
  sourceUrl: string | null;
  applyUrl: string | null;
  attribution: string | null;
  postedAt: Date | null;
  createdAt: Date;
  isActive: boolean;
}

export type JobListItem = Omit<JobView, "description" | "requirements"> & { excerpt: string };

export interface JobPage {
  items: JobListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface JobFacets {
  /** Distinct locations of active jobs, alphabetical. */
  locations: string[];
  /** Most common skills across active jobs. */
  skills: Array<{ name: string; count: number }>;
  totalActive: number;
}

const EXCERPT_CHARS = 220;

/** JSON columns come back as unknown JSON; accept only an array of strings. */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toExcerpt(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS).replace(/\s+\S*$/, "")}…`;
}

export function toJobView(row: JobRow): JobView {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    country: row.country,
    roleCategory: row.roleCategory,
    sector: row.sector,
    workMode: row.workMode,
    seniority: row.seniority,
    employmentType: row.employmentType,
    description: row.description,
    skills: toStringArray(row.skills),
    requirements: toStringArray(row.requirements),
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    applyUrl: row.applyUrl,
    attribution: row.attribution,
    postedAt: row.postedAt,
    createdAt: row.createdAt,
    isActive: row.isActive,
  };
}

function toListItem(row: JobRow): JobListItem {
  const { description, requirements: _requirements, ...rest } = toJobView(row);
  return { ...rest, excerpt: toExcerpt(description) };
}

/** Prisma `create` data for a validated job. Exported so the seed script uses the same mapping. */
export function toCreateData(
  input: CreateJobInput,
  dedupeHash: string = computeDedupeHash(input),
): Prisma.JobCreateInput {
  return {
    title: input.title,
    company: input.company,
    location: input.location ?? null,
    country: input.country ?? null,
    roleCategory: input.roleCategory,
    sector: input.sector,
    workMode: input.workMode,
    seniority: input.seniority,
    employmentType: input.employmentType,
    description: input.description,
    skills: input.skills,
    requirements: input.requirements,
    salaryMin: input.salaryMin ?? null,
    salaryMax: input.salaryMax ?? null,
    salaryCurrency: input.salaryCurrency ?? null,
    sourceName: input.sourceName,
    sourceUrl: input.sourceUrl ?? null,
    applyUrl: input.applyUrl ?? null,
    attribution: input.attribution ?? null,
    externalId: input.externalId ?? null,
    postedAt: input.postedAt ?? null,
    dedupeHash,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const MAX_SEARCH_TERMS = 6;

function buildWhere(query: ListJobsQuery): Prisma.JobWhereInput {
  const and: Prisma.JobWhereInput[] = [{ isActive: query.isActive ?? true }];

  // Every word must appear somewhere in title, company, location or description.
  const terms = (query.q ?? "").split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  for (const term of terms) {
    and.push({
      OR: [
        { title: { contains: term } },
        { company: { contains: term } },
        { location: { contains: term } },
        { description: { contains: term } },
      ],
    });
  }

  if (query.roleCategory) and.push({ roleCategory: query.roleCategory });
  if (query.sector) and.push({ sector: query.sector });
  if (query.workMode) and.push({ workMode: query.workMode });
  if (query.seniority) and.push({ seniority: query.seniority });
  if (query.location) {
    and.push({ OR: [{ location: { contains: query.location } }, { country: { contains: query.location } }] });
  }
  return { AND: and };
}

async function idsMatchingAllSkills(where: Prisma.JobWhereInput, wanted: string[]): Promise<string[]> {
  const needles = wanted.map((skill) => skill.toLowerCase());
  const rows = await prisma.job.findMany({ where, select: { id: true, skills: true } });
  return rows
    .filter((row) => {
      const have = new Set(toStringArray(row.skills).map((skill) => skill.toLowerCase()));
      return needles.every((needle) => have.has(needle));
    })
    .map((row) => row.id);
}

export async function listJobs(query: ListJobsQuery): Promise<JobPage> {
  let where = buildWhere(query);
  if (query.skills.length > 0) {
    const ids = await idsMatchingAllSkills(where, query.skills);
    where = { AND: [where, { id: { in: ids } }] };
  }

  const [total, rows] = await Promise.all([
    prisma.job.count({ where }),
    prisma.job.findMany({
      where,
      // SQLite sorts NULL last for DESC, so jobs without a posted date sink below dated ones.
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export async function getJobById(id: string): Promise<JobView | null> {
  const row = await prisma.job.findUnique({ where: { id } });
  return row ? toJobView(row) : null;
}

export async function getJobFacets(limits: { skills?: number; locations?: number } = {}): Promise<JobFacets> {
  const rows = await prisma.job.findMany({
    where: { isActive: true },
    select: { location: true, skills: true },
  });

  const locations = new Set<string>();
  const counts = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    if (row.location) locations.add(row.location);
    for (const skill of toStringArray(row.skills)) {
      const key = skill.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { name: skill, count: 1 });
    }
  }

  return {
    locations: [...locations].sort((a, b) => a.localeCompare(b)).slice(0, limits.locations ?? 100),
    skills: [...counts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, limits.skills ?? 24),
    totalActive: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createJob(input: CreateJobInput): Promise<JobView> {
  const data = toCreateData(input);
  const existing = await prisma.job.findUnique({
    where: { dedupeHash: data.dedupeHash },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError("This job is already on the board (same company, title and location).");
  }
  return toJobView(await prisma.job.create({ data }));
}

/** Idempotent insert used by the seed script: an existing job with the same fingerprint is kept. */
export async function upsertJobByFingerprint(input: CreateJobInput): Promise<{ job: JobView; created: boolean }> {
  const data = toCreateData(input);
  const existing = await prisma.job.findUnique({ where: { dedupeHash: data.dedupeHash } });
  if (existing) return { job: toJobView(existing), created: false };
  return { job: toJobView(await prisma.job.create({ data })), created: true };
}

// ---------------------------------------------------------------------------
// Feed ingestion
// ---------------------------------------------------------------------------

const SQLITE_IN_CHUNK = 400;

/** Which of these fingerprints are already stored (one parameterized query per chunk). */
export async function findExistingDedupeHashes(hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < hashes.length; start += SQLITE_IN_CHUNK) {
    const chunk = hashes.slice(start, start + SQLITE_IN_CHUNK);
    const rows = await prisma.job.findMany({ where: { dedupeHash: { in: chunk } }, select: { dedupeHash: true } });
    for (const row of rows) found.add(row.dedupeHash);
  }
  return found;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Store an imported job under its feed fingerprint. A fingerprint (or source + external id) that
 * already exists is not an error: another sync, or a concurrent request, got there first.
 */
export async function insertImportedJob(
  input: CreateJobInput,
  dedupeHash: string,
): Promise<"created" | "duplicate"> {
  try {
    await prisma.job.create({ data: toCreateData(input, dedupeHash) });
    return "created";
  } catch (error) {
    if (isUniqueViolation(error)) return "duplicate";
    throw error;
  }
}

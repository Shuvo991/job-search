/**
 * Turns an "Add Job" request (structured form or pasted raw text) into a validated, sanitised job
 * ready to store. Pure: no database, no network, no randomness (the clock is injectable), so the
 * same function backs the API route, the seed script and the unit tests.
 *
 * Security properties:
 *  - every string is reduced to plain text (src/lib/sanitize.ts) before it is validated or stored
 *  - URLs must be http(s) without credentials; they are stored, never fetched (no SSRF surface)
 *  - the final object is re-validated with createJobSchema, so the database only ever sees values
 *    that satisfy the same rules as every other writer
 */
import { extractRequirements } from "@/lib/job-inference";
import { analyzeRawPosting, uniqueSkills } from "@/lib/jobs/analyze";
import { isLoneUrl, normalizeHttpUrl, sanitizeInline, sanitizeText } from "@/lib/sanitize";
import { canonicalizeSkillName, extractSkillNames } from "@/lib/skills-extractor";
import { ValidationError, type ValidationIssue } from "@/lib/errors";
import { parseWith } from "@/lib/validation";
import type { AddJobRequest, RawJobRequest, StructuredJobRequest } from "@/schemas/job-input";
import { createJobSchema, type CreateJobInput } from "@/schemas/job";

function issue(path: string, message: string): ValidationIssue {
  return { path, message, code: "custom" };
}

/** Sanitised single-line value, or undefined when it is blank (or nothing survives sanitising). */
function optionalInline(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeInline(value);
  return clean === "" ? undefined : clean;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").slice(0, 100);
  } catch {
    return "pasted";
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildStructured(input: StructuredJobRequest, now: Date): unknown {
  const title = sanitizeInline(input.title);
  const description = sanitizeText(input.description);

  const issues: ValidationIssue[] = [];
  let applyUrl: string | undefined;
  if (input.applyUrl !== undefined && input.applyUrl.trim() !== "") {
    applyUrl = normalizeHttpUrl(input.applyUrl);
    if (applyUrl === undefined) issues.push(issue("applyUrl", "Enter a valid http(s) link"));
  }
  if (issues.length > 0) throw new ValidationError(issues);

  const provided = uniqueSkills(
    input.skills.map((skill) => canonicalizeSkillName(sanitizeInline(skill))).filter((skill) => skill !== ""),
  );
  const skills = provided.length > 0 ? provided : uniqueSkills(extractSkillNames(`${title}\n${description}`));
  const currency = optionalInline(input.salaryCurrency);

  return {
    title,
    company: sanitizeInline(input.company),
    location: optionalInline(input.location),
    country: optionalInline(input.country),
    roleCategory: input.roleCategory,
    sector: input.sector,
    workMode: input.workMode,
    seniority: input.seniority,
    employmentType: input.employmentType,
    description,
    skills,
    requirements: extractRequirements(description),
    salaryMin: input.salaryMin,
    salaryMax: input.salaryMax,
    salaryCurrency: currency,
    sourceName: "manual",
    applyUrl,
    postedAt: now,
  };
}

function buildRaw(input: RawJobRequest, now: Date): unknown {
  const issues: ValidationIssue[] = [];

  if (isLoneUrl(input.text)) {
    issues.push(
      issue("text", "That looks like a link. Paste the job description text itself and put the link in the URL field."),
    );
  }

  let url: string | undefined;
  if (input.url !== undefined && input.url.trim() !== "") {
    url = normalizeHttpUrl(input.url);
    if (url === undefined) issues.push(issue("url", "Enter a valid http(s) link"));
  }

  const analysis = analyzeRawPosting(input);
  if (!isLoneUrl(input.text) && analysis.description === "") {
    issues.push(issue("text", "Nothing is left of the pasted text after removing markup. Paste the job description."));
  }

  const roleCategory = input.roleCategory ?? analysis.roleCategory;
  if (roleCategory === undefined) {
    issues.push(issue("roleCategory", "Could not tell the role type from the title. Please choose one."));
  }
  if (issues.length > 0) throw new ValidationError(issues);

  return {
    title: sanitizeInline(input.title),
    company: sanitizeInline(input.company),
    location: optionalInline(input.location),
    roleCategory,
    sector: analysis.sector,
    workMode: analysis.workMode,
    seniority: analysis.seniority,
    employmentType: analysis.employmentType,
    description: analysis.description,
    skills: analysis.skills,
    requirements: analysis.requirements,
    sourceName: url === undefined ? "pasted" : hostLabel(url),
    sourceUrl: url,
    applyUrl: url,
    postedAt: now,
  };
}

/** Drop keys whose value is undefined so optional fields are truly absent (not `undefined`). */
function withoutUndefined(candidate: unknown): unknown {
  if (typeof candidate !== "object" || candidate === null) return candidate;
  return Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined));
}

/**
 * Sanitise, enrich and validate an Add Job request.
 * Throws ValidationError (HTTP 400) with field-level paths that match the form's field names.
 */
export function buildJobFromRequest(request: AddJobRequest, now: Date = new Date()): CreateJobInput {
  const candidate = request.mode === "structured" ? buildStructured(request, now) : buildRaw(request, now);
  return parseWith(createJobSchema, withoutUndefined(candidate));
}

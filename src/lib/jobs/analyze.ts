/**
 * Sanitise pasted job text and infer everything that can be inferred deterministically.
 *
 * Kept free of server-only and Zod imports so the Add Job form can run the very same analysis in
 * the browser for its live preview that the API runs before saving.
 */
import {
  extractRequirements,
  inferEmploymentType,
  inferRoleCategory,
  inferSector,
  inferSeniority,
  inferWorkMode,
  type EmploymentTypeValue,
  type RoleCategoryValue,
  type SectorValue,
  type SeniorityValue,
  type WorkModeValue,
} from "@/lib/job-inference";
import { sanitizeInline, sanitizeText } from "@/lib/sanitize";
import { extractSkillNames } from "@/lib/skills-extractor";

export const MAX_SKILLS = 100;

/** Case-insensitive de-duplication that keeps first-seen spelling and order. */
export function uniqueSkills(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= MAX_SKILLS) break;
  }
  return result;
}

export interface RawPostingAnalysis {
  /** Sanitised plain-text description. */
  description: string;
  skills: string[];
  requirements: string[];
  roleCategory: RoleCategoryValue | undefined;
  seniority: SeniorityValue;
  workMode: WorkModeValue;
  employmentType: EmploymentTypeValue;
  sector: SectorValue;
}

/** Sanitise pasted text and infer everything that can be inferred deterministically. */
export function analyzeRawPosting(input: {
  title: string;
  company?: string | undefined;
  location?: string | undefined;
  text: string;
}): RawPostingAnalysis {
  const title = sanitizeInline(input.title);
  const company = sanitizeInline(input.company ?? "");
  const location = sanitizeInline(input.location ?? "");
  const description = sanitizeText(input.text);

  return {
    description,
    skills: uniqueSkills(extractSkillNames(`${title}\n${description}`)),
    requirements: extractRequirements(description),
    roleCategory: inferRoleCategory(title),
    seniority: inferSeniority(title),
    workMode: inferWorkMode(title, location, description),
    employmentType: inferEmploymentType(title, description),
    sector: inferSector(title, company, description),
  };
}


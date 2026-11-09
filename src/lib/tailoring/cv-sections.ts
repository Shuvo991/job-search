/**
 * Finds sections of the CV (summary, skills) and builds the skills list in plain code.
 * The AI is not trusted with these: a small model tends to replace a skills list with category names,
 * so the skills come from the CV itself and are only re-ordered for the job.
 */
import { isHeadingLine } from "@/lib/tailoring/reflow";
import { normalizeForMatch } from "@/lib/tailoring/guardrails";

export const SUMMARY_HEADING = /^(?:(?:professional|executive|career|personal)\s+)?(?:summary|profile)\b|^about(?:\s+me)?$|^objective$/i;
export const SKILLS_HEADING = /\b(?:skills|competencies|expertise|technologies|tech stack)\b/i;

export interface CvSection {
  /** Index of the heading line. */
  headingIndex: number;
  /** The lines under the heading, up to the next heading. */
  lines: string[];
  /** Indexes (0-based) of those lines in the CV's line table. */
  indexes: number[];
}

/** The first section whose heading matches, or null. `lines` are the CV's lines in order. */
export function findSection(lines: readonly string[], heading: RegExp): CvSection | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!isHeadingLine(line) || !heading.test(line.trim())) continue;
    const body: string[] = [];
    const indexes: number[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      if (isHeadingLine(next)) break;
      body.push(next);
      indexes.push(j);
    }
    return { headingIndex: i, lines: body, indexes };
  }
  return null;
}

/** Split on | , ; and bullet dots, but not inside brackets: "Cloud (Azure, AWS)" stays one skill. */
function splitSkillList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    if ((char === ")" || char === "]") && depth > 0) depth -= 1;
    if (depth === 0 && /[|,;•·●▪]/u.test(char)) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** The skills the CV itself lists, in the CV's own wording (category labels are kept as entries). */
export function extractCvSkills(lines: readonly string[]): string[] {
  const section = findSection(lines, SKILLS_HEADING);
  if (!section) return [];
  const skills: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const skill = value.replace(/\s+/g, " ").replace(/[.:]+$/, "").trim();
    if (skill.length < 2 || skill.length > 70 || skill.split(" ").length > 7) return;
    const key = skill.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    skills.push(skill);
  };
  for (const line of section.lines) {
    let body = line;
    const colon = body.indexOf(":");
    if (colon > 0 && colon <= 60 && /[|,;•·]/u.test(body.slice(colon + 1))) {
      // "Category: a | b | c": the category label is the candidate's own wording and an ATS reads it
      // as a keyword ("Product Strategy & Lifecycle"), so it stays, followed by its items.
      add(body.slice(0, colon));
      body = body.slice(colon + 1);
    }
    for (const part of splitSkillList(body)) add(part);
  }
  return skills;
}

/** Skills the job posting mentions go first; everything else keeps the CV's own order. */
export function orderSkillsForJob(skills: readonly string[], jobText: string, jobSkills: readonly string[]): string[] {
  const jobPadded = ` ${normalizeForMatch(`${jobText}\n${jobSkills.join("\n")}`)} `;
  const matched: string[] = [];
  const rest: string[] = [];
  for (const skill of skills) {
    const normalized = normalizeForMatch(skill);
    (normalized.length >= 3 && jobPadded.includes(` ${normalized} `) ? matched : rest).push(skill);
  }
  return [...matched, ...rest];
}

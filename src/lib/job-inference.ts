/**
 * Deterministic field inference for pasted job postings (no LLM).
 *
 * Used when a user pastes raw text: the title and description are scanned with ordered regex
 * rules to suggest role category, seniority, work mode, employment type and sector, and to pull
 * the bullet list under a "Requirements" style heading. Everything here is a best-effort default;
 * the Add Job form lets the user override any of it, and `undefined` / "UNKNOWN" is returned
 * rather than a guess whenever the evidence is thin.
 *
 * Pure functions, safe on the server and in the browser (used for the live preview).
 */
import type { EMPLOYMENT_TYPES, ROLE_CATEGORIES, SECTORS, SENIORITIES, WORK_MODES } from "@/schemas/enums";

export type RoleCategoryValue = (typeof ROLE_CATEGORIES)[number];
export type SectorValue = (typeof SECTORS)[number];
export type WorkModeValue = (typeof WORK_MODES)[number];
export type SeniorityValue = (typeof SENIORITIES)[number];
export type EmploymentTypeValue = (typeof EMPLOYMENT_TYPES)[number];

/** How much of a description is inspected for work mode / employment type / sector hints. */
const HEAD_CHARS = 2_500;

// ---------------------------------------------------------------------------
// Role category (title only: descriptions mention every role under the sun)
// ---------------------------------------------------------------------------

// Order matters: the first matching rule wins, so specific rules come before generic ones.
const ROLE_RULES: ReadonlyArray<readonly [RoleCategoryValue, RegExp]> = [
  [
    "AI_ENGINEER",
    /\b(?:ai|ml|llm|nlp|genai|machine[- ]learning|deep[- ]learning|generative ai|computer vision)\b.*\b(?:engineer|developer|scientist|researcher)\b|\b(?:engineer|developer)\b.*\b(?:ai|ml|llm|machine[- ]learning)\b|\bmlops\b|\bprompt engineer|\bapplied scientist/i,
  ],
  [
    "DATA_ENGINEER",
    /\b(?:data|analytics|big data|etl|dataops)\b.*\b(?:engineer|architect)\b|\bengineer\b.*\bdata (?:platform|infrastructure|pipelines?)\b/i,
  ],
  ["PRODUCT_ANALYST", /\bproduct (?:data |insights? )?analyst|\bgrowth analyst|\bproduct analytics\b/i],
  [
    "DATA_ANALYST",
    /\bdata (?:analyst|scientist)|\banalytics analyst|\bbi (?:analyst|developer)|\bbusiness intelligence|\binsights? analyst|\breporting analyst|\bquantitative analyst/i,
  ],
  ["PRODUCT_MANAGER", /\bproduct (?:manager|owner|lead|management)|\bhead of product|\bgroup product\b|\bgpm\b|\bapm\b/i],
  [
    "PROJECT_MANAGER",
    /\b(?:project|program|programme|delivery|release) (?:manager|lead|director)|\bscrum master|\bagile coach|\bpmo\b/i,
  ],
  [
    "BUSINESS_ANALYST",
    /\bbusiness (?:systems? )?analyst|\bsystems? analyst|\brequirements? analyst|\bfunctional analyst|\bprocess analyst/i,
  ],
  ["SOFTWARE_ARCHITECT", /\barchitect\b/i],
  ["SOFTWARE_DEVELOPER", /\b(?:developer|programmer|dev)\b/i],
  ["SOFTWARE_ENGINEER", /\bengineer(?:ing)?\b|\bsre\b|\bdevops\b|\bsdet\b/i],
];

export function inferRoleCategory(title: string): RoleCategoryValue | undefined {
  for (const [category, pattern] of ROLE_RULES) {
    if (pattern.test(title)) return category;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Seniority (title only)
// ---------------------------------------------------------------------------

export function inferSeniority(title: string): SeniorityValue {
  if (/\b(?:intern|internship|trainee|working student|werkstudent)\b/i.test(title)) return "INTERN";
  if (/\b(?:principal|staff|distinguished|fellow)\b/i.test(title)) return "PRINCIPAL";
  if (/\b(?:lead|head of|director|engineering manager)\b/i.test(title)) return "LEAD";
  if (/\b(?:senior|sr)\b\.?/i.test(title)) return "SENIOR";
  if (/\b(?:junior|jr|graduate|entry[- ]level|associate|apprentice|early[- ]career)\b\.?/i.test(title)) return "JUNIOR";
  if (/\b(?:mid|mid[- ]level|intermediate)\b/i.test(title)) return "MID";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Work mode
// ---------------------------------------------------------------------------

export function inferWorkMode(...texts: Array<string | undefined>): WorkModeValue {
  const text = texts
    .filter((value): value is string => Boolean(value))
    .map((value) => value.slice(0, HEAD_CHARS))
    .join("\n");

  const negatedRemote = /\b(?:no|not|non)(?:[- ]|\s+an?\s+)remote\b/i.test(text);
  const hybrid = /\bhybrid\b/i.test(text);
  const remote = !negatedRemote && /\bremote(?:ly)?\b|\bwork from (?:home|anywhere)\b|\bwfh\b/i.test(text);
  const onsite = negatedRemote || /\bon[- ]?site\b|\bin[- ]office\b|\boffice[- ]based\b|\bin[- ]person\b/i.test(text);

  if (hybrid) return "HYBRID";
  if (remote && onsite) return "HYBRID";
  if (remote) return "REMOTE";
  if (onsite) return "ONSITE";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Employment type
// ---------------------------------------------------------------------------

export function inferEmploymentType(title: string, description = ""): EmploymentTypeValue {
  const text = `${title}\n${description.slice(0, HEAD_CHARS)}`;
  if (/\bintern(?:ship)?\b|\btrainee\b|\bworking student\b/i.test(title)) return "INTERNSHIP";
  if (/\bfreelanc(?:e|ers?)\b/i.test(text)) return "FREELANCE";
  if (
    /\bcontract\b/i.test(title) ||
    /\b(?:contract (?:basis|position|role|job|engagement|to hire)|contractor|fixed[- ]term|\d+[- ]month contract|(?:employment|job) type:?\s*contract)\b/i.test(
      text,
    )
  ) {
    return "CONTRACT";
  }
  if (/\bpart[- ]time\b/i.test(text)) return "PART_TIME";
  if (/\bfull[- ]time\b|\bpermanent (?:position|role|contract|employment)\b/i.test(text)) return "FULL_TIME";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Sector
// ---------------------------------------------------------------------------

export function inferSector(title: string, company: string, description = ""): SectorValue {
  const gamingWords = "games?|gaming|gameplay|esports|unity|unreal|steam|playstation|xbox|nintendo";
  if (new RegExp(`\\b(?:${gamingWords})\\b`, "i").test(title)) return "GAMING";
  const haystack = `${company}\n${description.slice(0, HEAD_CHARS)}`;
  if ((haystack.match(new RegExp(`\\b(?:${gamingWords})\\b`, "gi")) ?? []).length >= 3) return "GAMING";

  const it =
    /\b(?:it (?:services|support|consulting|operations|infrastructure)|helpdesk|service desk|system administrator|sysadmin|managed services|erp|sap|network engineer|infrastructure engineer)\b/gi;
  if ((`${title}\n${haystack}`.match(it) ?? []).length >= 2) return "IT";
  return "TECH";
}

// ---------------------------------------------------------------------------
// Requirements section
// ---------------------------------------------------------------------------

const REQUIREMENTS_HEADING =
  /^(?:#{1,6}\s*)?(?:requirements?|qualifications?|minimum qualifications|basic qualifications|must[- ]haves?|what you(?:'ll| will)? (?:need|bring)|who you are|you have|about you|skills (?:&|and) experience|what we(?:'re| are) looking for)\s*:?\s*$/i;
const OTHER_HEADING =
  /^(?:#{1,6}\s*)?(?:nice[- ]to[- ]haves?|preferred(?: qualifications)?|bonus(?: points)?|benefits|perks|what we offer|our offer|why join|about (?:us|the company|the role|the team)|responsibilities|what you(?:'ll| will) do|the role|how to apply|equal opportunity)\b[^\n]{0,40}$/i;
const BULLET = /^(?:[-*•–·]|\d{1,2}[.)])\s+(\S.*)$/;

export function extractRequirements(description: string, limit = 25): string[] {
  const requirements: string[] = [];
  let inSection = false;

  for (const rawLine of description.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (REQUIREMENTS_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (OTHER_HEADING.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const bullet = BULLET.exec(line);
    if (bullet?.[1]) {
      requirements.push(bullet[1].slice(0, 500));
      if (requirements.length >= limit) break;
    }
  }
  return requirements;
}

/**
 * Offline, deterministic ATS scorer.
 *
 * Compares the plain text of a resume with the skills extracted from a job posting and with the
 * heuristics in `config/ats-rules.json`. No LLM, no network, no clock, no randomness: the same
 * text, skills and rules always produce the same report, and every point of the score can be
 * traced to a component in `report.components`.
 *
 * Score = sum over components of (ratio 0..1) x (weight). Default weights (editable in the JSON):
 *   keywords 40   share of the job's skills that the resume mentions
 *   sections 15   Experience / Education / Skills present (Summary / Projects count half)
 *   formatting 15 starts at 100%, loses a penalty per raised red flag (high 35%, medium 20%, low 8%)
 *   actionVerbs 15 share of bullet lines that start with a strong action verb, vs the target density
 *   language 10   falls with each distinct buzzword / weak phrase ("team player", "responsible for")
 *   length 5      word count inside the ideal range
 * When the job has no skills the keyword component is "not applicable" and the other weights are
 * scaled up so the score still spans 0-100.
 *
 * Known limits (by design, because the matching is lexical): a skill is found only when the resume
 * spells it in a form the skills dictionary or the job's own wording knows; negation ("no Java
 * experience") is not understood; layout (columns, text boxes, images) can only be inferred from
 * the extracted text, so the formatting checks are indicators, not proof.
 *
 * Pure functions with no Node-only imports, so the browser can run the very same scoring for a
 * live preview.
 */
import { z } from "zod";
import rulesJson from "../../config/ats-rules.json";
import { countWords, normalizeResumeText } from "@/lib/resume/text";
import { getSkillExtractor } from "@/lib/skills-extractor";

// ---------------------------------------------------------------------------
// Rules: validated once so a bad edit of the JSON fails loudly and early
// ---------------------------------------------------------------------------

const severitySchema = z.enum(["high", "medium", "low"]);
const weightSchema = z.number().min(0);
const phraseListSchema = z.array(z.string().trim().min(1)).min(1);
const rangeSchema = z.object({ min: z.number().positive(), max: z.number().positive() });

const flagRuleSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  kind: z.enum(["forbid", "require"]),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/),
  minMatches: z.number().int().min(1),
  message: z.string().min(1),
  fix: z.string().min(1),
});

const atsRulesSchema = z
  .object({
    version: z.string().min(1),
    weights: z.object({
      keywords: weightSchema,
      sections: weightSchema,
      formatting: weightSchema,
      actionVerbs: weightSchema,
      language: weightSchema,
      length: weightSchema,
    }),
    grades: z.array(z.object({ min: z.number().min(0).max(100), label: z.string().min(1) })).min(1),
    length: z.object({ ideal: rangeSchema, acceptable: rangeSchema, maxPages: z.number().int().positive() }),
    sections: z.object({
      recommendedWeight: z.number().min(0).max(1),
      definitions: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            required: z.boolean(),
            aliases: phraseListSchema,
          }),
        )
        .min(1),
    }),
    actionVerbs: z.object({
      targetDensity: z.number().gt(0).max(1),
      minCandidateLines: z.number().int().min(1),
      minBulletWords: z.number().int().min(1),
      fallbackMinWords: z.number().int().min(1),
      verbs: phraseListSchema,
      irregular: z.record(z.string(), z.array(z.string().min(1))),
      weakPhrases: phraseListSchema,
    }),
    language: z.object({ zeroScoreAt: z.number().int().min(1), buzzwords: phraseListSchema }),
    quantification: z.object({ minShare: z.number().min(0).max(1) }),
    formatting: z.object({
      severityPenalty: z.object({
        high: z.number().min(0).max(1),
        medium: z.number().min(0).max(1),
        low: z.number().min(0).max(1),
      }),
      maxPenalty: z.number().min(0).max(1),
      flags: z.array(flagRuleSchema),
    }),
  })
  .refine((rules) => Object.values(rules.weights).some((weight) => weight > 0), {
    message: "at least one weight must be greater than 0",
    path: ["weights"],
  })
  .refine(
    (rules) =>
      rules.length.acceptable.min < rules.length.ideal.min &&
      rules.length.ideal.min <= rules.length.ideal.max &&
      rules.length.ideal.max < rules.length.acceptable.max,
    { message: "need acceptable.min < ideal.min <= ideal.max < acceptable.max", path: ["length"] },
  );

export type AtsRules = z.output<typeof atsRulesSchema>;
type FlagRule = AtsRules["formatting"]["flags"][number];

interface PhraseMatcher {
  regex: RegExp | undefined;
  /** normalised phrase -> phrase as written in the rules */
  display: ReadonlyMap<string, string>;
}

export interface CompiledAtsRules {
  readonly version: string;
  readonly rules: AtsRules;
  readonly sectionByAlias: ReadonlyMap<string, string>;
  readonly verbForms: ReadonlySet<string>;
  readonly weakPhrases: PhraseMatcher;
  readonly buzzwords: PhraseMatcher;
  readonly flags: ReadonlyArray<{ rule: FlagRule; regex: RegExp }>;
}

const SEPARATOR = String.raw`[\s\-\u2010-\u2015]+`;
const SEPARATOR_SPLIT = /[\s\-\u2010-\u2015]+/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[\s\-\u2010-\u2015]+/g, " ").trim();
}

function buildPhraseMatcher(phrases: readonly string[]): PhraseMatcher {
  const display = new Map<string, string>();
  for (const phrase of phrases) {
    const key = normalizePhrase(phrase);
    if (!display.has(key)) display.set(key, phrase.trim());
  }
  // Longest first so "dynamic professional" wins over a shorter overlapping phrase.
  const keys = [...display.keys()].sort((a, b) => b.length - a.length);
  const alternatives = keys.map((key) => key.split(" ").map(escapeRegExp).join(SEPARATOR)).join("|");
  return {
    regex: keys.length === 0 ? undefined : new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alternatives})(?![\p{L}\p{N}])`, "giu"),
    display,
  };
}

/** Lower-case a heading so "TECHNICAL SKILLS:" and "Technical Skills" compare equal. */
function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * All the forms of a verb that may start a bullet. Verbs are written in the past tense in the
 * rules; this adds the base form, third person and -ing form of regular verbs
 * ("managed" -> manage, manages, managing; "planned" -> plan, plans, planning).
 */
export function expandVerbForms(pastTense: string): string[] {
  const past = pastTense.toLowerCase().trim();
  const forms = new Set<string>([past]);
  const bases: string[] = [];
  let stem = "";

  if (past.endsWith("ied") && past.length > 4) {
    bases.push(`${past.slice(0, -3)}y`);
    stem = past.slice(0, -2);
  } else if (past.endsWith("ed") && past.length > 3) {
    stem = past.slice(0, -2); // develop(ed), manag(ed), plann(ed)
    bases.push(stem, past.slice(0, -1)); // develop, manag | developE, manage
    const last = stem.at(-1);
    if (last !== undefined && last === stem.at(-2)) bases.push(stem.slice(0, -1)); // plann -> plan
  }

  for (const base of bases) {
    forms.add(base);
    forms.add(`${base}s`);
    forms.add(`${base}es`);
    if (base.endsWith("y")) forms.add(`${base.slice(0, -1)}ies`);
  }
  if (stem !== "") forms.add(`${stem}ing`); // developing, managing, planning
  if (bases[0]?.endsWith("y")) forms.add(`${bases[0]}ing`); // simplifying
  return [...forms];
}

export function compileAtsRules(raw: unknown): CompiledAtsRules {
  const parsed = atsRulesSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    throw new Error(`ats rules: ${detail}`);
  }
  const rules = parsed.data;

  const sectionByAlias = new Map<string, string>();
  for (const definition of rules.sections.definitions) {
    for (const alias of definition.aliases) {
      const key = normalizeHeading(alias);
      const existing = sectionByAlias.get(key);
      if (existing !== undefined && existing !== definition.id) {
        throw new Error(`ats rules: heading '${alias}' belongs to both '${existing}' and '${definition.id}'`);
      }
      sectionByAlias.set(key, definition.id);
    }
  }

  const verbForms = new Set<string>();
  for (const verb of rules.actionVerbs.verbs) for (const form of expandVerbForms(verb)) verbForms.add(form);
  for (const [past, forms] of Object.entries(rules.actionVerbs.irregular)) {
    verbForms.add(past.toLowerCase());
    for (const form of forms) verbForms.add(form.toLowerCase());
  }

  const flags = rules.formatting.flags.map((rule) => {
    const flagSet = new Set(rule.flags.split(""));
    flagSet.add("g"); // matches are always counted globally
    try {
      return { rule, regex: new RegExp(rule.pattern, [...flagSet].join("")) };
    } catch {
      throw new Error(`ats rules: formatting flag '${rule.id}' has an invalid pattern`);
    }
  });

  return {
    version: rules.version,
    rules,
    sectionByAlias,
    verbForms,
    weakPhrases: buildPhraseMatcher(rules.actionVerbs.weakPhrases),
    buzzwords: buildPhraseMatcher(rules.language.buzzwords),
    flags,
  };
}

let defaultRules: CompiledAtsRules | undefined;

/** The bundled `config/ats-rules.json`, compiled on first use. */
export function getAtsRules(): CompiledAtsRules {
  defaultRules ??= compileAtsRules(rulesJson);
  return defaultRules;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type WarningSeverity = "high" | "medium" | "low";
export type ScoreComponentId = "keywords" | "sections" | "formatting" | "actionVerbs" | "language" | "length";

export interface AtsWarning {
  id: string;
  severity: WarningSeverity;
  message: string;
  fix: string;
  /** Short excerpts of the offending text (at most three), when the check has any. */
  evidence?: string[];
}

export interface ScoreComponent {
  id: ScoreComponentId;
  label: string;
  /** Weight configured in ats-rules.json. */
  weight: number;
  /** Points this component can contribute after scaling out any not-applicable component. */
  maxPoints: number;
  /** Points earned (one decimal). */
  points: number;
  /** Earned share, 0..1. */
  ratio: number;
  applicable: boolean;
  summary: string;
}

export interface KeywordReport {
  /** Distinct skills in the job posting that were considered. */
  total: number;
  matched: string[];
  /** Job skills the resume does not mention, in the job's own order (most important first). */
  missing: string[];
  /** matched / total, 0..1 (0 when the job lists no skills). */
  matchRate: number;
}

export interface ActionVerbReport {
  /** Bullet lines (or long plain lines for DOCX) that were examined. */
  candidateLines: number;
  withActionVerb: number;
  /** withActionVerb / candidateLines, 0..1. */
  density: number;
  targetDensity: number;
  /** Distinct strong verbs the resume starts bullets with, most used first (max 15). */
  verbsUsed: string[];
  /** Up to five examples of lines that do not start with an action verb. */
  linesWithoutVerb: string[];
  /** Share of examined lines that contain a number, %, or currency amount. */
  quantifiedShare: number;
}

export interface SectionReport {
  found: string[];
  missingRequired: string[];
  missingRecommended: string[];
}

export interface PhraseCount {
  phrase: string;
  count: number;
}

export interface LanguageReport {
  buzzwords: PhraseCount[];
  weakPhrases: PhraseCount[];
}

export type LengthStatus = "empty" | "too_short" | "short" | "ideal" | "long" | "too_long";

export interface LengthReport {
  wordCount: number;
  pageCount: number | undefined;
  status: LengthStatus;
  idealRange: { min: number; max: number };
}

export interface AtsReport {
  rulesVersion: string;
  /** Integer 0-100. */
  overallScore: number;
  grade: string;
  components: ScoreComponent[];
  keywords: KeywordReport;
  formattingWarnings: AtsWarning[];
  actionVerbs: ActionVerbReport;
  sections: SectionReport;
  language: LanguageReport;
  length: LengthReport;
  /** The most useful fixes, in priority order (at most eight). */
  recommendations: string[];
}

export interface ScoreResumeInput {
  /** Plain text of the resume, as returned by POST /api/resume/parse. */
  resumeText: string;
  /** Skills extracted from the selected job (`Job.skills`), most important first. */
  jobSkills: readonly string[];
  /** Page count when known (PDF). Omit for DOCX. */
  pageCount?: number | undefined;
}

// ---------------------------------------------------------------------------
// Analysis steps (each is a pure function of the text and the rules)
// ---------------------------------------------------------------------------

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;

function snippet(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}\u2026` : flat;
}

function containsLiteral(text: string, term: string): boolean {
  const parts = term.trim().slice(0, 60).split(SEPARATOR_SPLIT).map(escapeRegExp);
  if (parts.join("") === "") return false;
  // Very short terms ("C", "R") are matched case-sensitively so they do not hit ordinary words.
  const flags = term.trim().length <= 2 ? "u" : "iu";
  return new RegExp(String.raw`(?<![\p{L}\p{N}_])${parts.join(SEPARATOR)}(?![\p{L}\p{N}_])`, flags).test(text);
}

function analyzeKeywords(text: string, jobSkills: readonly string[]): KeywordReport {
  const extractor = getSkillExtractor();
  const foundInResume = new Set(extractor.names(text).map((name) => name.toLowerCase()));

  const seen = new Set<string>();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const raw of jobSkills) {
    const skill = raw.trim();
    if (skill === "") continue;
    // Known skills are compared by canonical name ("ReactJS" == "React"); unknown ones literally.
    const canonical = extractor.canonicalName(skill);
    const name = canonical ?? skill;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = canonical === undefined ? containsLiteral(text, skill) : foundInResume.has(key);
    (hit ? matched : missing).push(name);
  }

  const total = matched.length + missing.length;
  return { total, matched, missing, matchRate: total === 0 ? 0 : round2(matched.length / total) };
}

function detectSections(lines: readonly string[], compiled: CompiledAtsRules): Set<string> {
  const found = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.length > 80) continue;
    const colon = trimmed.indexOf(":");
    const head = colon > 0 ? trimmed.slice(0, colon) : trimmed;
    if (head.length > 40) continue;
    const id = compiled.sectionByAlias.get(normalizeHeading(head));
    if (id !== undefined) found.add(id);
  }
  return found;
}

function analyzeSections(lines: readonly string[], compiled: CompiledAtsRules): SectionReport {
  const present = detectSections(lines, compiled);
  const { definitions } = compiled.rules.sections;
  return {
    found: definitions.filter((d) => present.has(d.id)).map((d) => d.label),
    missingRequired: definitions.filter((d) => d.required && !present.has(d.id)).map((d) => d.label),
    missingRecommended: definitions.filter((d) => !d.required && !present.has(d.id)).map((d) => d.label),
  };
}

function sectionRatio(report: SectionReport, compiled: CompiledAtsRules): number {
  const { definitions, recommendedWeight } = compiled.rules.sections;
  let earned = 0;
  let possible = 0;
  for (const definition of definitions) {
    const weight = definition.required ? 1 : recommendedWeight;
    possible += weight;
    const missing = definition.required
      ? report.missingRequired.includes(definition.label)
      : report.missingRecommended.includes(definition.label);
    if (!missing) earned += weight;
  }
  return possible === 0 ? 1 : clamp01(earned / possible);
}

const BULLET_MARKER =
  /^[ \t]*(?:[-*\u2022\u00B7\u25AA\u25AB\u25E6\u25CF\u25CB\u25A0\u25A1\u2023\u2043\u2013\u2014\u27A2\u27A4\u2713\u2714\u25BA\u25B6\u2192\uE000-\uF8FF>]|\d{1,2}[.)])[ \t]*/;
const FIRST_WORD = /^[^\p{L}]*(\p{L}[\p{L}'\u2019]*)/u;
const HAS_NUMBER = /\d|%|[$\u20AC\u00A3]/;

function wordCountOf(value: string): number {
  return countWords(value);
}

function analyzeActionVerbs(lines: readonly string[], compiled: CompiledAtsRules): ActionVerbReport {
  const { minCandidateLines, minBulletWords, fallbackMinWords, targetDensity } = compiled.rules.actionVerbs;

  const marked: string[] = [];
  const plain: string[] = [];
  for (const line of lines) {
    const match = BULLET_MARKER.exec(line);
    if (match) {
      const body = line.slice(match[0].length).trim();
      if (wordCountOf(body) >= minBulletWords) marked.push(body);
    } else {
      const body = line.trim();
      // Long plain lines stand in for bullets: DOCX text extraction drops the bullet glyphs.
      if (wordCountOf(body) >= fallbackMinWords && !body.includes("@")) plain.push(body);
    }
  }
  const candidates = marked.length >= minCandidateLines ? marked : [...marked, ...plain];

  const usedCounts = new Map<string, number>();
  const without: string[] = [];
  let withVerb = 0;
  let quantified = 0;
  for (const candidate of candidates) {
    if (HAS_NUMBER.test(candidate)) quantified += 1;
    const word = FIRST_WORD.exec(candidate)?.[1]?.toLowerCase();
    if (word !== undefined && compiled.verbForms.has(word)) {
      withVerb += 1;
      usedCounts.set(word, (usedCounts.get(word) ?? 0) + 1);
    } else {
      without.push(snippet(candidate));
    }
  }

  const total = candidates.length;
  return {
    candidateLines: total,
    withActionVerb: withVerb,
    density: total === 0 ? 0 : round2(withVerb / total),
    targetDensity,
    verbsUsed: [...usedCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 15)
      .map(([verb]) => verb),
    linesWithoutVerb: without.slice(0, 5),
    quantifiedShare: total === 0 ? 0 : round2(quantified / total),
  };
}

function countPhrases(text: string, matcher: PhraseMatcher): PhraseCount[] {
  if (!matcher.regex) return [];
  const counts = new Map<string, number>();
  for (const match of text.matchAll(matcher.regex)) {
    const phrase = matcher.display.get(normalizePhrase(match[0])) ?? match[0].toLowerCase();
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}

function analyzeLength(
  wordCount: number,
  pageCount: number | undefined,
  compiled: CompiledAtsRules,
): { report: LengthReport; ratio: number } {
  const { ideal, acceptable } = compiled.rules.length;
  let status: LengthStatus;
  let ratio: number;
  if (wordCount === 0) {
    status = "empty";
    ratio = 0;
  } else if (wordCount < acceptable.min) {
    status = "too_short";
    ratio = 0.5 * (wordCount / acceptable.min);
  } else if (wordCount < ideal.min) {
    status = "short";
    ratio = 0.5 + 0.5 * ((wordCount - acceptable.min) / (ideal.min - acceptable.min));
  } else if (wordCount <= ideal.max) {
    status = "ideal";
    ratio = 1;
  } else if (wordCount <= acceptable.max) {
    status = "long";
    ratio = 1 - 0.5 * ((wordCount - ideal.max) / (acceptable.max - ideal.max));
  } else {
    status = "too_long";
    ratio = Math.max(0, 0.5 - 0.5 * ((wordCount - acceptable.max) / acceptable.max));
  }
  return {
    report: { wordCount, pageCount, status, idealRange: { min: ideal.min, max: ideal.max } },
    ratio: clamp01(ratio),
  };
}

function runFormattingFlags(text: string, compiled: CompiledAtsRules): AtsWarning[] {
  const warnings: AtsWarning[] = [];
  for (const { rule, regex } of compiled.flags) {
    const matches = [...text.matchAll(regex)];
    const raised = rule.kind === "forbid" ? matches.length >= rule.minMatches : matches.length < rule.minMatches;
    if (!raised) continue;
    const warning: AtsWarning = { id: rule.id, severity: rule.severity, message: rule.message, fix: rule.fix };
    if (rule.kind === "forbid") warning.evidence = matches.slice(0, 3).map((match) => snippet(match[0]));
    warnings.push(warning);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const COMPONENT_LABELS: Readonly<Record<ScoreComponentId, string>> = {
  keywords: "Keyword match",
  sections: "Required sections",
  formatting: "ATS-safe formatting",
  actionVerbs: "Action verb density",
  language: "Buzzwords and weak phrases",
  length: "Length",
};

const SEVERITY_ORDER: Readonly<Record<WarningSeverity, number>> = { high: 0, medium: 1, low: 2 };

function gradeFor(score: number, compiled: CompiledAtsRules): string {
  const grades = [...compiled.rules.grades].sort((a, b) => b.min - a.min);
  return grades.find((grade) => score >= grade.min)?.label ?? grades.at(-1)?.label ?? "poor";
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * Score a resume against one job. Deterministic and side-effect free.
 *
 * @param input  resume text, the job's extracted skills, and the page count when known
 * @param compiled  rules to use; defaults to the bundled config/ats-rules.json
 */
export function scoreResume(input: ScoreResumeInput, compiled: CompiledAtsRules = getAtsRules()): AtsReport {
  const text = normalizeResumeText(input.resumeText);
  const lines = text.split("\n");
  const wordCount = countWords(text);
  const pageCount = input.pageCount;
  const { rules } = compiled;

  const keywords = analyzeKeywords(text, input.jobSkills);
  const sections = analyzeSections(lines, compiled);
  const actionVerbs = analyzeActionVerbs(lines, compiled);
  const length = analyzeLength(wordCount, pageCount, compiled);

  const buzzwords = countPhrases(text, compiled.buzzwords);
  const weakPhrases = countPhrases(text, compiled.weakPhrases);
  const language: LanguageReport = { buzzwords, weakPhrases };

  // Formatting warnings: configured red flags, plus page count and "no text at all".
  const formattingWarnings: AtsWarning[] = [];
  if (wordCount === 0) {
    formattingWarnings.push({
      id: "no-extractable-text",
      severity: "high",
      message: "No readable text was found in the resume.",
      fix: "If the file is a scan or an image, export a text-based PDF or upload a DOCX; an ATS cannot read pictures of text.",
    });
  } else {
    formattingWarnings.push(...runFormattingFlags(text, compiled));
  }
  if (pageCount !== undefined && pageCount > rules.length.maxPages) {
    formattingWarnings.push({
      id: "too-many-pages",
      severity: "medium",
      message: `The resume is ${pageCount} pages long; ${rules.length.maxPages} pages or fewer is the norm.`,
      fix: "Cut older or less relevant roles and keep the most recent, most relevant achievements.",
    });
  }
  formattingWarnings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Component ratios (0..1).
  const empty = wordCount === 0;
  const penalty = formattingWarnings.reduce((sum, warning) => sum + rules.formatting.severityPenalty[warning.severity], 0);
  const languageIssues = buzzwords.length + weakPhrases.length;
  const ratios: Record<ScoreComponentId, number> = {
    keywords: empty ? 0 : keywords.matchRate,
    sections: empty ? 0 : sectionRatio(sections, compiled),
    formatting: empty ? 0 : clamp01(1 - Math.min(rules.formatting.maxPenalty, penalty)),
    actionVerbs: empty || actionVerbs.candidateLines === 0 ? 0 : clamp01(actionVerbs.density / actionVerbs.targetDensity),
    language: empty ? 0 : clamp01(1 - languageIssues / rules.language.zeroScoreAt),
    length: length.ratio,
  };
  const applicable: Record<ScoreComponentId, boolean> = {
    keywords: keywords.total > 0,
    sections: true,
    formatting: true,
    actionVerbs: true,
    language: true,
    length: true,
  };
  const summaries: Record<ScoreComponentId, string> = {
    keywords: applicable.keywords
      ? `${keywords.matched.length} of ${keywords.total} job skills found (${percent(ratios.keywords)})`
      : "The job lists no skills, so keywords are not scored",
    sections:
      sections.missingRequired.length === 0
        ? "All required sections found"
        : `Missing required: ${sections.missingRequired.join(", ")}`,
    formatting:
      formattingWarnings.length === 0 ? "No formatting red flags" : `${formattingWarnings.length} formatting warning(s)`,
    actionVerbs:
      actionVerbs.candidateLines === 0
        ? "No bullet points found to check"
        : `${actionVerbs.withActionVerb} of ${actionVerbs.candidateLines} bullets start with an action verb (${percent(actionVerbs.density)}, target ${percent(actionVerbs.targetDensity)})`,
    language:
      languageIssues === 0
        ? "No buzzwords or weak phrases"
        : `${buzzwords.length} buzzword(s) and ${weakPhrases.length} weak phrase(s)`,
    length: `${wordCount} words (${length.report.status.replace("_", " ")}; ideal ${rules.length.ideal.min}-${rules.length.ideal.max})`,
  };

  const ids = Object.keys(COMPONENT_LABELS) as ScoreComponentId[];
  const totalWeight = ids.reduce((sum, id) => sum + (applicable[id] ? rules.weights[id] : 0), 0);
  const components: ScoreComponent[] = ids.map((id) => {
    const maxPoints = applicable[id] && totalWeight > 0 ? (rules.weights[id] / totalWeight) * 100 : 0;
    return {
      id,
      label: COMPONENT_LABELS[id],
      weight: rules.weights[id],
      maxPoints: round1(maxPoints),
      points: round1(maxPoints * ratios[id]),
      ratio: round2(ratios[id]),
      applicable: applicable[id],
      summary: summaries[id],
    };
  });

  const rawScore = ids.reduce(
    (sum, id) => sum + (applicable[id] && totalWeight > 0 ? (rules.weights[id] / totalWeight) * 100 * ratios[id] : 0),
    0,
  );
  const overallScore = Math.min(100, Math.max(0, Math.round(rawScore)));

  // Recommendations, most valuable first.
  const recommendations: string[] = [];
  if (empty) {
    recommendations.push(formattingWarnings[0]?.fix ?? "Upload a resume with selectable text.");
  } else {
    if (sections.missingRequired.length > 0) {
      recommendations.push(`Add the missing section(s) with a standard heading: ${sections.missingRequired.join(", ")}.`);
    }
    if (keywords.missing.length > 0) {
      recommendations.push(
        `Work these job skills into your experience or skills section where they are true: ${keywords.missing.slice(0, 8).join(", ")}.`,
      );
    }
    for (const warning of formattingWarnings.filter((w) => w.severity !== "low")) recommendations.push(warning.fix);
    if (actionVerbs.candidateLines > 0 && actionVerbs.density < actionVerbs.targetDensity) {
      recommendations.push(
        `Start more bullets with a strong verb such as Led, Built, Reduced or Delivered (now ${percent(actionVerbs.density)}, target ${percent(actionVerbs.targetDensity)}).`,
      );
    }
    if (actionVerbs.candidateLines >= rules.actionVerbs.minCandidateLines && actionVerbs.quantifiedShare < rules.quantification.minShare) {
      recommendations.push("Quantify results: add numbers, percentages or amounts to more bullets.");
    }
    if (languageIssues > 0) {
      const names = [...buzzwords, ...weakPhrases].slice(0, 5).map((item) => `"${item.phrase}"`);
      recommendations.push(`Replace vague wording with concrete achievements: ${names.join(", ")}.`);
    }
    if (length.report.status === "too_short") {
      recommendations.push("The resume is very short; add detail on your most relevant roles and projects.");
    } else if (length.report.status === "too_long") {
      recommendations.push("The resume is very long; trim it to the most relevant experience.");
    }
  }

  return {
    rulesVersion: compiled.version,
    overallScore,
    grade: gradeFor(overallScore, compiled),
    components,
    keywords,
    formattingWarnings,
    actionVerbs,
    sections,
    language,
    length: length.report,
    recommendations: recommendations.slice(0, 8),
  };
}

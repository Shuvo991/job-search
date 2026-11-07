/**
 * Deterministic skill extractor.
 *
 * Parses free text (a job description) against the curated dictionary in
 * `config/skills-dictionary.json`. No LLM, no network, no randomness: the same text and
 * dictionary always produce the same result. Pure functions only, so it is safe to run on
 * the server (API routes, seed script) and in the browser (live preview in the Add Job form).
 *
 * How matching works
 *  1. The text is normalised (NFKC, zero-width characters removed, curly quotes straightened).
 *  2. Every dictionary term is compiled into one of three regex passes:
 *       - insensitive: "TypeScript", "typescript" and "TYPESCRIPT" all match
 *       - exact:       case-sensitive, for acronyms and words that are also plain English
 *                      ("REST" but not "rest", "Excel" but not "excel", "Swift" but not "swift")
 *       - contextual:  case-sensitive AND only inside a skill list ("Go, Rust",
 *                      "experience with R and Python"), so "Go to market" and "R&D" never match
 *  3. All hits from all passes are merged; where hits overlap the earliest, longest one wins
 *     ("React Native" beats "React", "Spring Boot" beats "Spring").
 *  4. Hits are counted per canonical skill.
 *
 * Known limits (by design, because the matching is lexical): negation ("no experience with
 * Java") is not understood, and a skill that is not in the dictionary is never found. Add it
 * to the JSON file; no code change is needed.
 */
import dictionaryJson from "../../config/skills-dictionary.json";

export type SkillKind = "technical" | "soft";
type MatchMode = "insensitive" | "exact" | "contextual";
type NameMatch = MatchMode | "none";

export interface SkillDefinition {
  name: string;
  category: string;
  kind: SkillKind;
  nameMatch: NameMatch;
  aliases: string[];
  exact: string[];
  contextual: string[];
}

export interface ExtractedSkill {
  /** Canonical label, e.g. "React" for "ReactJS". */
  name: string;
  kind: SkillKind;
  category: string;
  /** Number of non-overlapping mentions. */
  count: number;
  /** Offset of the first mention in the normalised text (approximate for display/sorting). */
  firstIndex: number;
  /** Distinct surface forms found in the text (max 5), e.g. ["ReactJS", "React"]. */
  matchedAs: string[];
}

export interface ExtractOptions {
  /** Restrict the result to technical or soft skills. */
  kinds?: readonly SkillKind[];
  /** Keep only the first N skills after sorting (most mentioned first). */
  limit?: number;
}

export interface SkillExtractor {
  readonly version: string;
  readonly definitions: readonly SkillDefinition[];
  extract(text: string, options?: ExtractOptions): ExtractedSkill[];
  /** Canonical skill names only, most mentioned first. */
  names(text: string, options?: ExtractOptions): string[];
  /** Map a user-typed skill ("reactjs", "postgres") to its canonical name, if it is known. */
  canonicalName(input: string): string | undefined;
}

/** Input beyond this length is ignored; bounds worst-case work on pasted documents. */
export const MAX_EXTRACT_CHARS = 200_000;

// ---------------------------------------------------------------------------
// Dictionary parsing (validates the JSON so a bad edit fails loudly and early)
// ---------------------------------------------------------------------------

interface ParsedDictionary {
  version: string;
  definitions: SkillDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`skills dictionary: ${where} must be an array of non-empty strings`);
  }
  return value.map((item: string) => item.trim());
}

export function parseSkillDictionary(raw: unknown): ParsedDictionary {
  if (!isRecord(raw)) throw new Error("skills dictionary: root must be an object");
  const { version, categories, skills } = raw;
  if (typeof version !== "string") throw new Error("skills dictionary: 'version' must be a string");
  if (!isRecord(categories)) throw new Error("skills dictionary: 'categories' must be an object");
  if (!Array.isArray(skills)) throw new Error("skills dictionary: 'skills' must be an array");

  const definitions: SkillDefinition[] = skills.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) throw new Error(`skills dictionary: skills[${index}] must be an object`);
    const { name, category, nameMatch } = entry;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`skills dictionary: skills[${index}].name must be a non-empty string`);
    }
    if (typeof category !== "string") {
      throw new Error(`skills dictionary: '${name}' needs a category`);
    }
    const categoryInfo = categories[category];
    if (!isRecord(categoryInfo) || (categoryInfo["kind"] !== "technical" && categoryInfo["kind"] !== "soft")) {
      throw new Error(`skills dictionary: '${name}' uses unknown category '${category}'`);
    }
    const mode = nameMatch ?? "insensitive";
    if (mode !== "insensitive" && mode !== "exact" && mode !== "contextual" && mode !== "none") {
      throw new Error(`skills dictionary: '${name}' has invalid nameMatch '${String(mode)}'`);
    }
    return {
      name: name.trim(),
      category,
      kind: categoryInfo["kind"],
      nameMatch: mode,
      aliases: stringList(entry["aliases"], `${name}.aliases`),
      exact: stringList(entry["exact"], `${name}.exact`),
      contextual: stringList(entry["contextual"], `${name}.contextual`),
    };
  });

  return { version, definitions };
}

// ---------------------------------------------------------------------------
// Text normalisation and pattern building
// ---------------------------------------------------------------------------

/** One or more spaces, hyphens or dashes. Spaces and hyphens in a term are interchangeable. */
const SEPARATOR_SOURCE = String.raw`[\s\-\u2010-\u2015]+`;
const SEPARATOR_SPLIT = /[\s\-\u2010-\u2015]+/;

function prepareText(text: string): string {
  return text
    .slice(0, MAX_EXTRACT_CHARS)
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lookup key for a term or a matched string: separators collapsed, slashes tightened. */
function keyFor(text: string, caseSensitive: boolean): string {
  const collapsed = text
    .normalize("NFKC")
    .trim()
    .replace(SEPARATOR_SPLIT, " ")
    .replace(/\s*\/\s*/g, "/");
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

function termToPattern(term: string, allowPlural: boolean): string {
  const parts = term.normalize("NFKC").trim().split(SEPARATOR_SPLIT);
  const body = parts
    .map((part) => escapeRegExp(part).replace(/\//g, String.raw`\s*\/\s*`))
    .join(SEPARATOR_SOURCE);
  const endsWithWordChar = /[\p{L}\p{N}]$/u.test(term);
  return allowPlural && endsWithWordChar ? `${body}(?:e?s)?` : body;
}

const BOUNDARY_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}_])`;

interface Term {
  text: string;
  mode: MatchMode;
  skill: number;
}

interface CompiledPass {
  regex: RegExp | undefined;
  lookup: Map<string, number>;
}

function compilePass(terms: Term[], mode: MatchMode): CompiledPass {
  const own = terms.filter((term) => term.mode === mode);
  const lookup = new Map<string, number>();
  for (const term of own) lookup.set(keyFor(term.text, mode !== "insensitive"), term.skill);
  if (own.length === 0) return { regex: undefined, lookup };

  // Longest term first so the regex engine prefers "React Native" over "React".
  const sorted = [...own].sort((a, b) => b.text.length - a.text.length);
  const allowPlural = mode !== "contextual";
  const alternatives = sorted.map((term) => termToPattern(term.text, allowPlural)).join("|");
  const flags = mode === "insensitive" ? "giu" : "gu";
  return {
    regex: new RegExp(`${BOUNDARY_BEFORE}(?:${alternatives})${BOUNDARY_AFTER}`, flags),
    lookup,
  };
}

function resolveSkill(pass: CompiledPass, matched: string, mode: MatchMode): number | undefined {
  const key = keyFor(matched, mode !== "insensitive");
  const direct = pass.lookup.get(key);
  if (direct !== undefined) return direct;
  // The regex allowed a trailing plural ("Kafkas", "KPIs"); retry without it.
  if (mode !== "contextual") {
    if (key.endsWith("es")) {
      const found = pass.lookup.get(key.slice(0, -2));
      if (found !== undefined) return found;
    }
    if (key.endsWith("s")) return pass.lookup.get(key.slice(0, -1));
  }
  return undefined;
}

// Contextual terms ("Go", "R", "C", "Spring") are only accepted inside a skill list.
const CONTEXT_BEFORE = /(?:[,;:/(|•·*–—\n-][ \t]*|\b(?:in|with|using|and|or|including|like|plus|of)\s+)$/i;
const CONTEXT_AFTER = /^[ \t]*(?:$|\n|[,;/)|•·*(]|\.(?:\s|$)|\s+(?:and|or)\b)/i;

function hasListContext(text: string, start: number, end: number): boolean {
  if (start === 0) return CONTEXT_AFTER.test(text.slice(end, end + 24));
  const before = text.slice(Math.max(0, start - 24), start);
  return CONTEXT_BEFORE.test(before) && CONTEXT_AFTER.test(text.slice(end, end + 24));
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

interface RawHit {
  start: number;
  end: number;
  skill: number;
  surface: string;
}

export function createSkillExtractor(rawDictionary: unknown): SkillExtractor {
  const { version, definitions } = parseSkillDictionary(rawDictionary);

  const terms: Term[] = [];
  definitions.forEach((definition, skill) => {
    if (definition.nameMatch !== "none") terms.push({ text: definition.name, mode: definition.nameMatch, skill });
    for (const text of definition.aliases) terms.push({ text, mode: "insensitive", skill });
    for (const text of definition.exact) terms.push({ text, mode: "exact", skill });
    for (const text of definition.contextual) terms.push({ text, mode: "contextual", skill });
  });

  const passes: Array<{ mode: MatchMode; pass: CompiledPass }> = (
    ["insensitive", "exact", "contextual"] as const
  ).map((mode) => ({ mode, pass: compilePass(terms, mode) }));

  // For canonicalising user-typed skills: case-insensitive across every term.
  const canonicalLookup = new Map<string, number>();
  definitions.forEach((definition, skill) => {
    canonicalLookup.set(keyFor(definition.name, false), skill);
  });
  for (const term of terms) {
    const key = keyFor(term.text, false);
    if (!canonicalLookup.has(key)) canonicalLookup.set(key, term.skill);
  }

  function collectHits(text: string): RawHit[] {
    const hits: RawHit[] = [];
    for (const { mode, pass } of passes) {
      if (!pass.regex) continue;
      for (const match of text.matchAll(pass.regex)) {
        const surface = match[0];
        const start = match.index ?? 0;
        const end = start + surface.length;
        if (mode === "contextual" && !hasListContext(text, start, end)) continue;
        const skill = resolveSkill(pass, surface, mode);
        if (skill !== undefined) hits.push({ start, end, skill, surface });
      }
    }
    return hits;
  }

  function extract(input: string, options: ExtractOptions = {}): ExtractedSkill[] {
    const text = prepareText(input);
    if (text.trim() === "") return [];

    // Earliest first; for the same start, the longest. Then drop anything overlapping a kept hit.
    const hits = collectHits(text).sort((a, b) => a.start - b.start || b.end - a.end);
    const bySkill = new Map<number, ExtractedSkill>();
    let lastEnd = -1;
    for (const hit of hits) {
      if (hit.start < lastEnd) continue;
      lastEnd = hit.end;
      const definition = definitions[hit.skill];
      if (!definition) continue;
      const existing = bySkill.get(hit.skill);
      if (existing) {
        existing.count += 1;
        if (existing.matchedAs.length < 5 && !existing.matchedAs.includes(hit.surface)) {
          existing.matchedAs.push(hit.surface);
        }
      } else {
        bySkill.set(hit.skill, {
          name: definition.name,
          kind: definition.kind,
          category: definition.category,
          count: 1,
          firstIndex: hit.start,
          matchedAs: [hit.surface],
        });
      }
    }

    let result = [...bySkill.values()];
    if (options.kinds) {
      const allowed = new Set<SkillKind>(options.kinds);
      result = result.filter((skill) => allowed.has(skill.kind));
    }
    result.sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex || a.name.localeCompare(b.name));
    return options.limit === undefined ? result : result.slice(0, Math.max(0, options.limit));
  }

  return {
    version,
    definitions,
    extract,
    names: (text, options) => extract(text, options).map((skill) => skill.name),
    canonicalName(input) {
      const key = keyFor(input, false);
      const index = canonicalLookup.get(key) ?? canonicalLookup.get(key.replace(/e?s$/, ""));
      return index === undefined ? undefined : definitions[index]?.name;
    },
  };
}

// ---------------------------------------------------------------------------
// Default instance (built lazily so importing this module stays cheap)
// ---------------------------------------------------------------------------

let defaultExtractor: SkillExtractor | undefined;

export function getSkillExtractor(): SkillExtractor {
  defaultExtractor ??= createSkillExtractor(dictionaryJson);
  return defaultExtractor;
}

/** Extract skills from text using the bundled dictionary. */
export function extractSkills(text: string, options?: ExtractOptions): ExtractedSkill[] {
  return getSkillExtractor().extract(text, options);
}

/** Canonical skill names found in text, most mentioned first. */
export function extractSkillNames(text: string, options?: ExtractOptions): string[] {
  return getSkillExtractor().names(text, options);
}

/** Canonicalise a user-typed skill ("reactjs" -> "React"); unknown skills are returned trimmed. */
export function canonicalizeSkillName(input: string): string {
  return getSkillExtractor().canonicalName(input) ?? input.trim();
}

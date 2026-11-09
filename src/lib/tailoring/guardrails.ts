/**
 * Anti-fabrication guardrails for AI-tailored CVs and cover letters.
 *
 * The prompts in config/prompts/ TELL the model never to invent anything. This module CHECKS it,
 * because a prompt is a request, not a guarantee. Everything here is pure, deterministic and offline:
 *
 *  - snapToSource      find the real CV text a model "quoted" (fuzzy), so the "original" column of
 *                      the review UI is always the user's own words, never the model's paraphrase
 *  - findNewNumbers    a rewrite may only use numbers that were already in its original
 *  - findNewTerms      a rewrite may not introduce tools, products or names the CV does not mention
 *  - isFieldInSource   employers, titles, institutions and skills must exist in the CV
 *  - areDatesNearEntry dates must appear next to the employer/title they are attached to
 *
 * Matching is lexical on purpose. It can reject a legitimate rewrite (the user can still adopt it
 * with one click), but it should not let an invented fact through silently.
 */
import { extractSkillNames } from "@/lib/skills-extractor";

// ---------------------------------------------------------------------------
// Normalisation and source index
// ---------------------------------------------------------------------------

/** Lower-case, accent-preserving, punctuation-free form used for every comparison. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeForMatch(text);
  return normalized === "" ? [] : normalized.split(" ");
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

const LEADING_BULLET = /^[\s•·▪●◦■□►▶➢✓*\-–—>]+/u;
const MAX_INDEXED_LINES = 4_000;

interface SourceLine {
  /** The line as it appears in the CV, minus any leading bullet glyph. */
  raw: string;
  set: Set<string>;
}

export interface SourceIndex {
  text: string;
  /** " normalised text " (padded) so whole-phrase checks are a plain `includes`. */
  padded: string;
  tokens: Set<string>;
  lines: SourceLine[];
}

export function buildSourceIndex(text: string): SourceIndex {
  const lines: SourceLine[] = [];
  for (const rawLine of text.split("\n")) {
    const raw = rawLine.replace(LEADING_BULLET, "").replace(/\s+/g, " ").trim();
    const tokens = tokenize(raw);
    if (tokens.length === 0) continue;
    lines.push({ raw, set: new Set(tokens) });
    if (lines.length >= MAX_INDEXED_LINES) break;
  }
  const normalized = normalizeForMatch(text);
  return {
    text,
    padded: ` ${normalized} `,
    tokens: new Set(normalized === "" ? [] : normalized.split(" ")),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Snapping a model's "quote" to the real CV text
// ---------------------------------------------------------------------------

export interface SnapResult {
  /** The CV's own text (consecutive lines joined with a space). */
  text: string;
  /** 0..1 similarity between what the model wrote and what the CV says. */
  score: number;
}

export interface SnapOptions {
  /** Longest run of consecutive CV lines a single quote may span (a wrapped bullet is 2-3 lines). */
  maxWindow?: number;
  threshold?: number;
}

/**
 * Find the CV text the model meant. Compares word sets of the snippet with windows of consecutive CV
 * lines (Dice similarity; containment when the model quoted only part of a line). Returns null when
 * nothing is similar enough, which means the model did not copy the CV: treat it as invented.
 */
export function snapToSource(snippet: string, index: SourceIndex, options: SnapOptions = {}): SnapResult | null {
  const snippetTokens = tokenize(snippet);
  if (snippetTokens.length === 0) return null;
  const snippetSet = new Set(snippetTokens);
  const maxWindow = options.maxWindow ?? 4;
  const threshold = options.threshold ?? 0.88;

  let best: SnapResult | null = null;
  const { lines } = index;

  for (let start = 0; start < lines.length; start += 1) {
    const first = lines[start];
    if (!first) break;
    // A window must begin on a line that shares at least one word with the snippet.
    let overlaps = false;
    for (const token of first.set) {
      if (snippetSet.has(token)) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) continue;

    const union = new Set<string>();
    const parts: string[] = [];
    for (let size = 1; size <= maxWindow; size += 1) {
      const line = lines[start + size - 1];
      if (!line) break;
      for (const token of line.set) union.add(token);
      parts.push(line.raw);

      let shared = 0;
      for (const token of snippetSet) if (union.has(token)) shared += 1;
      const dice = (2 * shared) / (snippetSet.size + union.size);
      const containment = shared / snippetSet.size;
      const score = dice >= 0.6 ? Math.max(dice, containment) : dice;

      // Strictly greater: on a tie the shorter window (found first) wins.
      if (score >= threshold && (best === null || score > best.score)) {
        best = { text: parts.join(" "), score };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Fields: employers, titles, institutions, skills, dates
// ---------------------------------------------------------------------------

/** True when the value is empty (nothing was claimed) or really appears in the CV. */
export function isFieldInSource(value: string, index: SourceIndex): boolean {
  const normalized = normalizeForMatch(value);
  if (normalized === "") return true;
  if (index.padded.includes(` ${normalized} `)) return true;
  // Same words in the same short stretch of the CV (different punctuation or word order).
  return snapToSource(value, index, { maxWindow: 2, threshold: 0.99 }) !== null;
}

const PRESENT_WORDS = new Set([
  "present",
  "current",
  "currently",
  "now",
  "ongoing",
  "today",
  "nu",
  "idag",
  "nuvarande",
  "pågående",
]);
const YEAR = /^(?:19|20)\d{2}$/;
const DATE_RADIUS = 4;

/** Tokens of the CV lines within a few lines of any line that mentions all words of an anchor. */
function nearbyTokens(index: SourceIndex, anchors: readonly string[], radius: number): Set<string> | null {
  const anchorTokens = anchors.map(tokenize).filter((tokens) => tokens.length > 0);
  if (anchorTokens.length === 0) return null;

  const near = new Set<string>();
  let matches = 0;
  for (let i = 0; i < index.lines.length; i += 1) {
    const line = index.lines[i];
    if (!line || !anchorTokens.some((tokens) => tokens.every((token) => line.set.has(token)))) continue;
    matches += 1;
    for (let j = Math.max(0, i - radius); j <= Math.min(index.lines.length - 1, i + radius); j += 1) {
      for (const token of index.lines[j]?.set ?? []) near.add(token);
    }
  }
  return matches > 0 ? near : null;
}

/**
 * Dates must be written in the CV next to the employer or title they belong to (not merely
 * somewhere else in the document). Only years and "present" are checked; month spelling may differ.
 */
export function areDatesNearEntry(value: string, index: SourceIndex, anchors: readonly string[]): boolean {
  const tokens = tokenize(value);
  if (tokens.length === 0) return true;

  const years = tokens.filter((token) => YEAR.test(token));
  const present = tokens.filter((token) => PRESENT_WORDS.has(token));
  if (years.length === 0 && present.length === 0) return isFieldInSource(value, index);

  const scope = nearbyTokens(index, anchors, DATE_RADIUS) ?? index.tokens;
  if (!years.every((year) => scope.has(year))) return false;
  if (present.length > 0 && ![...PRESENT_WORDS].some((word) => scope.has(word))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

interface ParsedNumber {
  core: string;
  suffix: string;
  display: string;
}

const NUMBER_PATTERN = /\d+(?:[.,]\d+)*(?:\s?(?:%|[kKmMbBxX](?![\p{L}\p{N}])))?/gu;

function parseNumbers(text: string): ParsedNumber[] {
  const result: ParsedNumber[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const parts = /^(\d+(?:[.,]\d+)*)\s?(%|[kKmMbBxX])?$/u.exec(match[0]);
    if (!parts?.[1]) continue;
    result.push({
      core: parts[1].replace(/,/g, ""),
      suffix: (parts[2] ?? "").toLowerCase(),
      display: match[0].trim(),
    });
  }
  return result;
}

/**
 * Numbers in `candidate` that appear in none of `sources`. "45%" matches "45 percent"; "10k" must be
 * written as "10k" (or "10K") in a source. Spelled-out numbers ("three") are not checked.
 */
export function findNewNumbers(candidate: string, sources: readonly string[]): string[] {
  const allowedFull = new Set<string>();
  const allowedCore = new Set<string>();
  for (const source of sources) {
    for (const number of parseNumbers(source)) {
      allowedFull.add(number.core + number.suffix);
      allowedCore.add(number.core);
    }
  }

  const fresh: string[] = [];
  for (const number of parseNumbers(candidate)) {
    const known =
      allowedFull.has(number.core + number.suffix) ||
      ((number.suffix === "" || number.suffix === "%") && allowedCore.has(number.core));
    if (!known && !fresh.includes(number.display)) fresh.push(number.display);
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// New terms (tools, products, names)
// ---------------------------------------------------------------------------

const SENTENCE_END = /[.!?]["')\]]?$/;
const MIXED_CASE = /\p{Ll}\p{Lu}|\p{Lu}{2,}|\p{L}\d|\d\p{L}/u;

function cleanWord(word: string): string {
  return word
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}+#]+$/u, "")
    .replace(/['’]s$/i, "");
}

const skillCache = new WeakMap<SourceIndex, Set<string>>();

/** Technical skills named in the CV (cached: the dictionary scan is the expensive part). */
function technicalSkillsOf(source: SourceIndex): Set<string> {
  let skills = skillCache.get(source);
  if (!skills) {
    skills = new Set(extractSkillNames(source.text, { kinds: ["technical"] }).map((name) => name.toLowerCase()));
    skillCache.set(source, skills);
  }
  return skills;
}

export interface NewTermOptions {
  /** Extra text whose capitalised words are acceptable (for a letter: the job title and company). */
  alsoAllowed?: SourceIndex;
  limit?: number;
}

/**
 * Tools, technologies, products and names in `text` that the CV never mentions. Two detectors:
 *  1. the skills dictionary (technical skills only), compared with the CV text only, so a keyword
 *     copied from the job posting is caught even though the job posting mentions it;
 *  2. capitalised words in mid-sentence, ALL-CAPS, camelCase and letter+digit words ("Kubernetes",
 *     "AWS", "iOS", "S3") that do not occur in the CV.
 */
export function findNewTerms(text: string, source: SourceIndex, options: NewTermOptions = {}): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(term);
    }
  };

  const inCv = technicalSkillsOf(source);
  for (const name of extractSkillNames(text, { kinds: ["technical"] })) {
    if (inCv.has(name.toLowerCase())) continue;
    // The job title and company (the only outside names a letter may use) may contain such a phrase.
    if (options.alsoAllowed?.padded.includes(` ${normalizeForMatch(name)} `)) continue;
    add(name);
  }

  const words = text.split(/\s+/).filter((word) => word !== "");
  words.forEach((word, i) => {
    const cleaned = cleanWord(word);
    if (cleaned.length < 2) return;
    const previous = words[i - 1];
    const atSentenceStart = previous === undefined || SENTENCE_END.test(previous);
    const looksLikeName = /^\p{Lu}/u.test(cleaned) && !atSentenceStart;
    if (!looksLikeName && !MIXED_CASE.test(cleaned)) return;

    const parts = tokenize(cleaned);
    if (parts.length === 0) return;
    const known = (index: SourceIndex | undefined) => index !== undefined && parts.every((part) => index.tokens.has(part));
    if (known(source) || known(options.alsoAllowed)) return;
    add(cleaned);
  });

  return found.slice(0, options.limit ?? 5);
}

// ---------------------------------------------------------------------------
// One rewritten text (a bullet, a summary, a letter paragraph)
// ---------------------------------------------------------------------------

export interface CheckTextInput {
  /** The text before the rewrite, or null when there is none (a summary the CV never had). */
  original: string | null;
  suggested: string;
  source: SourceIndex;
  /** Texts the rewrite may take numbers from: [original] for a bullet, [whole CV] for a summary. */
  numberSources: readonly string[];
  alsoAllowedTerms?: SourceIndex;
  /** For a bullet: the rewrite must keep the original's numbers and most of its length. */
  keepDetail?: boolean;
}

/** User-facing reasons why a suggestion cannot be trusted. Empty array = it passed every check. */
export function checkRewrittenText(input: CheckTextInput): string[] {
  const flags: string[] = [];
  const { original, suggested } = input;

  if (suggested.trim() === "") return ["The AI returned an empty rewrite."];

  const numbers = findNewNumbers(suggested, input.numberSources);
  if (numbers.length > 0) {
    flags.push(`Contains a number that is not in your CV for this item: ${numbers.join(", ")}.`);
  }

  const termOptions: NewTermOptions = input.alsoAllowedTerms ? { alsoAllowed: input.alsoAllowedTerms } : {};
  const terms = findNewTerms(suggested, input.source, termOptions);
  if (terms.length > 0) {
    flags.push(`Mentions something your CV does not: ${terms.join(", ")}.`);
  }

  if (original !== null) {
    const before = wordCount(original);
    const after = wordCount(suggested);
    if (after > before * 2 && after - before > 12) {
      flags.push("Much longer than your original. Check that it adds no claims you cannot back up.");
    }
  }

  if (input.keepDetail === true && original !== null) {
    // Losing one of several figures is a normal edit; losing two, or the only one, loses the result.
    const total = findNewNumbers(original, []).length;
    const lost = findNewNumbers(original, [suggested]);
    if (lost.length >= 2 || (total > 0 && lost.length === total)) {
      flags.push(`Dropped a number from your original: ${lost.join(", ")}. A result should stay in the bullet.`);
    }
    const before = wordCount(original);
    if (before >= 12 && wordCount(suggested) < before * 0.5) {
      flags.push("Much shorter than your original, so details were probably lost.");
    }
  }

  if (/\[[^\]\n]{1,40}\]/.test(suggested)) {
    flags.push("Contains a [placeholder] that needs real text.");
  }
  return flags;
}

/**
 * Choosing WHAT the cover letter talks about is done in plain code, not by the model.
 *
 * A small local model asked to "pick the best evidence" picks an award line for a strategy role. Code can
 * do this reliably: score every achievement line of the CV by how much of the job it touches (job skills,
 * words of the title and requirements, a figure to point at), then take the best lines, from different
 * roles when possible. The model only gets to put ONE chosen line into words, and the line itself is the
 * letter's evidence, so every claim in the letter sits next to the CV line it came from.
 */
import { looksLikeHeader } from "@/lib/tailoring/build-draft";
import { SKILLS_HEADING, SUMMARY_HEADING, findSection } from "@/lib/tailoring/cv-sections";
import { buildSourceIndex, normalizeForMatch, tokenize } from "@/lib/tailoring/guardrails";
import { cleanLine } from "@/lib/tailoring/build-draft";
import { isHeadingLine } from "@/lib/tailoring/reflow";

export interface LetterJobContext {
  title: string;
  skills: readonly string[];
  requirements: readonly string[];
}

export interface EvidenceLine {
  /** The user's own wording of the achievement line. */
  text: string;
  /** The job header the line sits under ("Senior Product Manager | Acme AB | 2021 - Present"), for context. */
  context: string[];
  /** Identifies the role, so two lines from the same role are not both chosen when there is a choice. */
  roleKey: string;
  /** The job requirement this line speaks to best ("" when none), so the paragraph can end on it. */
  need: string;
  score: number;
}

const STOPWORDS = new Set(
  (
    "with that this from have will your their about into over under between within across through also well such " +
    "other more than which where when these those being able good must should could would each both only very " +
    "experience ability strong working work works skills skill knowledge understanding responsible including " +
    "years year role roles team teams demonstrated proven excellent plus preferably related relevant " +
    "opportunity opportunities company companies business needs need based using use used"
  ).split(" "),
);

/** A deliberately crude stem so that "strategies" meets "strategy" and "defined" meets "define". */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  let result = word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (result.endsWith(suffix) && result.length - suffix.length >= 4) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }
  return result.length > 4 && result.endsWith("e") ? result.slice(0, -1) : result;
}

/** Lower-case content words of a text: at least four letters, no stop words, lightly stemmed. */
export function significantWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of tokenize(text)) {
    if (token.length < 4 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
    words.add(stem(token));
  }
  return words;
}

const MIN_WORDS = 9;
const MAX_WORDS = 90;
const MIN_BODY_PARAGRAPHS = 2;
/** A line about receiving an award is not a story to build a paragraph on. */
const AWARD_LINE = /\b(award|awarded|prize|recognition|recognised|recognized|honou?red)\b/i;
/** After the first, a line must touch the job (a skill, or two content words) to earn a paragraph of its own. */
const MIN_EXTRA_RELEVANCE = 2;
/** Sections whose lines are not work achievements: study, volunteering, awards, languages. */
const NOT_WORK_HEADING = /volunteer|activit|extracurricular|award|certif|education|language|interest|publication|reference|hobb|training|course/i;
const MAX_CONTEXT_LINES = 3;
const LOOK_BACK_LINES = 30;

function wordTotal(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/** The job header above line `index` (its date-range line plus up to two short lines before it). */
function contextFor(cvLines: readonly string[], index: number): string[] {
  for (let j = index - 1; j >= 0 && index - j <= LOOK_BACK_LINES; j -= 1) {
    const line = cvLines[j] ?? "";
    if (isHeadingLine(line)) return [];
    if (!looksLikeHeader(line)) continue;
    const context = [line];
    for (let k = j - 1; k >= 0 && context.length < MAX_CONTEXT_LINES; k -= 1) {
      const before = cvLines[k] ?? "";
      if (before.length > 70 || before.endsWith(".") || isHeadingLine(before) || looksLikeHeader(before)) break;
      context.unshift(before);
    }
    return context.map((entry) => cleanLine(entry, 120)).filter((entry) => entry !== "");
  }
  return [];
}

/**
 * The best `count` achievement lines of the CV for this job, strongest first.
 * `avoidText` is text the letter already says (the summary): lines that mostly repeat it are marked down,
 * so the body of the letter adds something new instead of retelling the opening.
 */
export function pickEvidence(cvText: string, job: LetterJobContext, count = 3, avoidText = ""): EvidenceLine[] {
  const source = buildSourceIndex(cvText);
  const cvLines = source.lines.map((line) => line.raw);

  const skip = new Set<number>();
  for (const heading of [SUMMARY_HEADING, SKILLS_HEADING]) {
    for (const index of findSection(cvLines, heading)?.indexes ?? []) skip.add(index);
  }

  // Lines under "Volunteering", "Education", "Awards"... are not work achievements.
  let notWork = false;
  for (const [index, line] of cvLines.entries()) {
    if (isHeadingLine(line)) notWork = NOT_WORK_HEADING.test(line);
    else if (notWork) skip.add(index);
  }

  const avoid = significantWords(avoidText);
  const jobWords = significantWords([job.title, ...job.requirements].join(" "));
  const skills = job.skills.map((skill) => normalizeForMatch(skill)).filter((skill) => skill !== "");

  const candidates: Array<EvidenceLine & { index: number; relevance: number }> = [];
  const awardLines = new Set<number>();
  for (const [index, raw] of cvLines.entries()) {
    if (skip.has(index) || isHeadingLine(raw) || looksLikeHeader(raw)) continue;
    if (/@|linkedin\.com|https?:\/\//i.test(raw)) continue;
    const text = cleanLine(raw, 600);
    const total = wordTotal(text);
    if (total < MIN_WORDS || total > MAX_WORDS) continue;

    const normalized = ` ${normalizeForMatch(text)} `;
    const skillHits = skills.filter((skill) => normalized.includes(` ${skill} `)).length;
    const lineWords = significantWords(text);
    let overlap = 0;
    for (const word of jobWords) if (lineWords.has(word)) overlap += 1;

    const context = contextFor(cvLines, index);
    let repeated = 0;
    for (const word of lineWords) if (avoid.has(word)) repeated += 1;
    const repeatsOpening = lineWords.size > 0 && repeated / lineWords.size >= 0.35;

    const relevance = 3 * skillHits + Math.min(overlap, 6);
    if (AWARD_LINE.test(text)) awardLines.add(index);
    const score =
      relevance +
      (/\d/.test(text) ? 1.5 : 0) +
      (total >= 12 && total <= 60 ? 1 : 0) +
      (context.length > 0 ? 2 : 0) -
      (repeatsOpening ? 4 : 0) -
      (awardLines.has(index) ? 3 : 0);
    candidates.push({ index, text, context, roleKey: context[context.length - 1] ?? `line-${index}`, need: "", score, relevance });
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: Array<EvidenceLine & { index: number; relevance: number }> = [];
  // 1. The best lines that touch the job, from different roles.
  for (const candidate of candidates) {
    if (chosen.length >= count) break;
    if (chosen.length > 0 && candidate.relevance < MIN_EXTRA_RELEVANCE) continue;
    if (chosen.some((existing) => existing.roleKey === candidate.roleKey)) continue;
    chosen.push(candidate);
  }
  // 2. Fewer roles than paragraphs wanted: more lines that touch the job at all, from any role.
  for (const candidate of candidates) {
    if (chosen.length >= count) break;
    if (!chosen.includes(candidate) && !awardLines.has(candidate.index) && candidate.relevance >= 1) chosen.push(candidate);
  }
  // 3. A letter needs at least two body paragraphs: take other work lines rather than stop at one.
  for (const candidate of candidates) {
    if (chosen.length >= MIN_BODY_PARAGRAPHS) break;
    if (!chosen.includes(candidate) && !awardLines.has(candidate.index) && candidate.context.length > 0) chosen.push(candidate);
  }

  // Each chosen line gets the job requirement it speaks to best, a different one each time, so every
  // paragraph can end by connecting to a need of the role.
  const needsLeft = job.requirements.map((requirement) => requirement.trim()).filter((requirement) => requirement !== "");
  // First the clear matches (two shared words), then any requirement that shares at least one word.
  for (const minimumHits of [2, 1]) {
    for (const pick of chosen) {
      if (pick.need !== "") continue;
      const lineWords = significantWords(pick.text);
      let bestIndex = -1;
      let bestHits = minimumHits - 1;
      for (const [index, requirement] of needsLeft.entries()) {
        let hits = 0;
        for (const word of significantWords(requirement)) if (lineWords.has(word)) hits += 1;
        if (hits > bestHits) {
          bestHits = hits;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0) {
        pick.need = (needsLeft[bestIndex] ?? "").slice(0, 160);
        needsLeft.splice(bestIndex, 1);
      }
    }
  }
  return chosen.map(({ text, context, roleKey, need, score }) => ({ text, context, roleKey, need, score }));
}

export interface RequirementCoverage {
  /** Requirements that a chosen CV line touches. */
  addressed: string[];
  /** Requirements that no line of the CV comes close to. */
  gaps: string[];
}

/**
 * Which job requirements the letter's evidence touches and which the CV does not touch at all, by
 * shared content words. A rough match, shown to the user as such: it is there to point at claims to
 * double-check, not to certify them.
 */
export function coverRequirements(
  requirements: readonly string[],
  chosenTexts: readonly string[],
  cvLines: readonly string[],
): RequirementCoverage {
  const chosen = chosenTexts.map((text) => significantWords(text));
  // Short lines (a job title, a heading) share words with a requirement without showing anything.
  const all = cvLines.filter((line) => wordTotal(line) >= 6).map((line) => significantWords(line));
  const addressed: string[] = [];
  const gaps: string[] = [];

  for (const requirement of requirements.slice(0, 12)) {
    const words = significantWords(requirement);
    if (words.size === 0) continue;
    const need = Math.max(2, Math.ceil(words.size * 0.4));
    const best = (pool: Array<Set<string>>) =>
      pool.reduce((top, lineWords) => {
        let hits = 0;
        for (const word of words) if (lineWords.has(word)) hits += 1;
        return Math.max(top, hits);
      }, 0);
    const text = requirement.trim().slice(0, 200);
    if (best(chosen) >= need) addressed.push(text);
    else if (best(all) < need) gaps.push(text);
  }
  return { addressed: addressed.slice(0, 6), gaps: gaps.slice(0, 6) };
}

/**
 * The cover letter, built the way the CV is: small steps that a local 7B model can do well.
 *
 *  1. CODE chooses what the letter is about: the 2 achievement lines of the CV that touch this job most
 *     (letter-evidence.ts), and the candidate's own summary for the opening.
 *  2. The MODEL puts ONE of those facts into words per call (two condensed sentences), never the whole
 *     letter. Each paragraph is checked at once (new numbers or names, lost figures, template phrases,
 *     "led" or "owned" that the CV line does not say, a line copied word for word, a repeat of the
 *     opening) and sent back once with the exact problem.
 *     A SECOND, tiny call writes one sentence that links the finished paragraph to a need of the role.
 *     When that sentence fails its checks the paragraph stands without it.
 *  3. CODE adds the parts that must not be creative: the closing paragraph (job title and company only),
 *     the requirement coverage and the gaps (by keywords). A gap is never written into the letter.
 *
 * The result goes through buildCoverLetterDraft like before, so every flag in the editor still applies.
 */
import type { JobView } from "@/lib/jobs/repository";
import {
  OllamaOutputError,
  OllamaTimeoutError,
  generateStructured,
  getOllamaConfig,
} from "@/lib/ollama-client";
import { DEFAULT_CLOSING, DEFAULT_GREETING, cleanLine, resolveSummaryOriginal } from "@/lib/tailoring/build-draft";
import {
  buildSourceIndex,
  checkRewrittenText,
  findNewNumbers,
  wordCount,
  type SourceIndex,
} from "@/lib/tailoring/guardrails";
import { coverRequirements, pickEvidence, significantWords, type EvidenceLine } from "@/lib/tailoring/letter-evidence";
import { copyRatio, findCliches, findScopeClaims } from "@/lib/tailoring/letter-checks";
import { buildLetterLinkMessage, buildLetterParagraphMessage } from "@/lib/tailoring/prompts";
import { letterLinkSchema, letterParagraphSchema, type CoverLetterLlmOutput } from "@/schemas/tailoring";

const MAX_CALL_MS = 180_000;
const PARAGRAPH_NUM_PREDICT = 300;
const BODY_PARAGRAPHS = 3;
const LINK_NUM_PREDICT = 120;
const OPENING_MAX_WORDS = 80;
const BODY_MAX_WORDS = 70;
const BODY_MIN_WORDS = 20;
const MIN_WORDS = 15;
/** A body paragraph whose 4-word runs are this much the CV line is a copy, not a condensed version. */
const MAX_COPY_RATIO = 0.6;
/** A body paragraph that reuses this much of the opening tells the same story twice. */
const MAX_OPENING_OVERLAP = 0.4;
const LINK_MAX_WORDS = 40;
const LINK_MIN_WORDS = 6;
const EVIDENCE_SNIPPET_CHARS = 400;

export type LetterJob = Pick<JobView, "title" | "company" | "skills" | "requirements">;

export interface ComposeLetterOptions {
  job: LetterJob;
  /** The cover-letter prompt text. */
  system: string;
  cvText: string;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  /** For tests: a stand-in for the model call. */
  generate?: typeof generateStructured;
}

export interface ComposeLetterResult {
  output: CoverLetterLlmOutput;
  model: string | null;
  calls: number;
  /** Things the user should know ("the opening was written from a template"). */
  notes: string[];
}

interface Item {
  kind: "opening" | "body";
  /** The fact base the model may use, and the only source of numbers for this paragraph. */
  facts: string;
  context: string[];
  /** Body paragraphs: the requirement of the role the link sentence ties the paragraph to (may be empty). */
  need: string;
  /** CV lines shown next to the paragraph. */
  evidence: string[];
}

/** The first `max` characters of a text, cut at a sentence end when there is one. */
function capAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut;
}

function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s+[A-Z]|$)/.exec(text.trim());
  return (match?.[0] ?? text).trim();
}

export async function composeLetter(options: ComposeLetterOptions): Promise<ComposeLetterResult> {
  const generate = options.generate ?? generateStructured;
  const callMs = Math.min(getOllamaConfig().timeoutMs, MAX_CALL_MS);
  const title = cleanLine(options.job.title, 120);
  const company = cleanLine(options.job.company, 120);
  const source: SourceIndex = buildSourceIndex(options.cvText);
  const cvLines = source.lines.map((line) => line.raw);
  const jobNames = buildSourceIndex(`${title}\n${company}`);
  const notes: string[] = [];

  // What the letter will be about, chosen by code.
  const summary = resolveSummaryOriginal([], source);
  const picks: EvidenceLine[] = pickEvidence(
    options.cvText,
    { title, skills: options.job.skills, requirements: options.job.requirements },
    BODY_PARAGRAPHS,
    summary ?? "",
  );
  const items: Item[] = [];
  if (summary !== null) {
    items.push({ kind: "opening", facts: summary, context: [], need: "", evidence: [capAtSentence(summary, EVIDENCE_SNIPPET_CHARS)] });
  }
  for (const pick of picks) items.push({ kind: "body", facts: pick.text, context: pick.context, need: pick.need, evidence: [pick.text] });

  let model: string | null = null;
  let calls = 0;

  const ask = async (item: Item, feedback?: string): Promise<string> => {
    const result = await generate({
      system: options.system,
      user: buildLetterParagraphMessage(options.job, {
        kind: item.kind,
        facts: item.facts,
        context: item.context,
        feedback,
      }),
      schema: letterParagraphSchema,
      model: options.model ?? model ?? undefined,
      signal: options.signal,
      temperature: feedback === undefined ? 0.3 : 0.5,
      numPredict: PARAGRAPH_NUM_PREDICT,
      timeoutMs: callMs,
    });
    calls += 1;
    model = result.model;
    return cleanLine(result.data.paragraph, 900);
  };

  /** The opening paragraph as written, so a body paragraph that retells it is caught. */
  let openingText = "";

  const problems = (item: Item, text: string): string[] => {
    const found = checkRewrittenText({
      original: null,
      suggested: text,
      source,
      numberSources: [item.facts, ...item.context],
      alsoAllowedTerms: jobNames,
    });
    if (text === "") return found;
    const cliches = findCliches(text);
    if (cliches.length > 0) {
      found.push(`It uses template phrases (${cliches.map((phrase) => `“${phrase}”`).join(", ")}). Say what the candidate did instead.`);
    }
    const claims = findScopeClaims(text, [item.facts]);
    if (claims.length > 0) {
      found.push(`It says “${claims.join("”, “")}”, but the CV does not. Use the verb the CV uses.`);
    }
    const total = findNewNumbers(item.facts, []).length;
    const lost = findNewNumbers(item.facts, [text]);
    if (total > 0 && lost.length === total) {
      found.push(`It drops every figure of the CV text (${lost.join(", ")}). Keep the key figures.`);
    }
    if (item.kind === "body" && /\bI am applying\b|\bI am writing\b/i.test(text)) {
      found.push("It repeats the application sentence. Only the opening paragraph says that; start with the work.");
    }
    if (item.kind === "body" && copyRatio(text, item.facts) >= MAX_COPY_RATIO) {
      found.push("It copies the CV line. Condense it to the two most relevant facts, in new sentences.");
    }
    if (item.kind === "body" && openingText !== "" && copyRatio(text, openingText) >= MAX_OPENING_OVERLAP) {
      found.push("It repeats what the opening paragraph already says. Write about this achievement only.");
    }
    const words = wordCount(text);
    const maxWords = item.kind === "opening" ? OPENING_MAX_WORDS : BODY_MAX_WORDS;
    const minWords = item.kind === "opening" ? MIN_WORDS : BODY_MIN_WORDS;
    if (words > maxWords) found.push(`It is ${words} words. Keep it under ${maxWords - 10} words.`);
    if (words < minWords) found.push("It is too short. Write 2 sentences.");
    return found;
  };

  /** One paragraph: ask, check, and ask once more with the exact problem. Null when the model fails. */
  const write = async (item: Item): Promise<{ text: string; problems: string[] } | null> => {
    try {
      let best = await ask(item);
      let bestProblems = problems(item, best);
      if (bestProblems.length > 0) {
        try {
          const second = await ask(item, bestProblems.join(" "));
          const secondProblems = problems(item, second);
          if (secondProblems.length <= bestProblems.length) {
            best = second;
            bestProblems = secondProblems;
          }
        } catch (err) {
          if (!(err instanceof OllamaOutputError || err instanceof OllamaTimeoutError)) throw err;
        }
      }
      return best === "" ? null : { text: best, problems: bestProblems };
    } catch (err) {
      // "Ollama is gone", "model missing", "cancelled" and "prompt too long" end the whole letter.
      if (!(err instanceof OllamaOutputError || err instanceof OllamaTimeoutError)) throw err;
      return null;
    }
  };

  const askLink = async (item: Item, paragraph: string, feedback?: string): Promise<string> => {
    const result = await generate({
      system: options.system,
      user: buildLetterLinkMessage(options.job, { paragraph, need: item.need, feedback }),
      schema: letterLinkSchema,
      model: options.model ?? model ?? undefined,
      signal: options.signal,
      temperature: feedback === undefined ? 0.3 : 0.5,
      numPredict: LINK_NUM_PREDICT,
      timeoutMs: callMs,
    });
    calls += 1;
    model = result.model;
    return cleanLine(result.data.sentence, 400);
  };

  const linkProblems = (item: Item, paragraph: string, sentence: string): string[] => {
    const found = checkRewrittenText({
      original: null,
      suggested: sentence,
      source,
      numberSources: [paragraph, item.facts, ...item.context],
      alsoAllowedTerms: jobNames,
    });
    if (sentence === "") return found;
    const cliches = findCliches(sentence);
    if (cliches.length > 0) {
      found.push(`It uses template phrases (${cliches.map((phrase) => `“${phrase}”`).join(", ")}). Say what the work showed.`);
    }
    const claims = findScopeClaims(sentence, [item.facts, paragraph]);
    if (claims.length > 0) {
      found.push(`It says “${claims.join("”, “")}”, but the paragraph does not. Do not claim more than the paragraph shows.`);
    }
    if (/\bI am applying\b|\bI am writing\b/i.test(sentence)) found.push("It repeats the application sentence.");
    if ((sentence.match(/[.!?](?:\s|$)/g) ?? []).length > 1) found.push("It is more than one sentence. Write exactly one.");
    const words = wordCount(sentence);
    if (words > LINK_MAX_WORDS) found.push(`It is ${words} words. Keep it under 30 words.`);
    if (words < LINK_MIN_WORDS) found.push("It is too short. Say what the work showed for the need.");
    const needWords = significantWords(item.need);
    if (![...significantWords(sentence)].some((word) => needWords.has(word))) {
      found.push(`It does not mention the need of the role (“${item.need}”). Name that need in plain words.`);
    }
    return found;
  };

  /** The link sentence of a finished body paragraph, or null when the model cannot get it clean. */
  const writeLink = async (item: Item, paragraph: string): Promise<string | null> => {
    if (item.need === "") return null;
    try {
      let sentence = await askLink(item, paragraph);
      let found = linkProblems(item, paragraph, sentence);
      if (found.length > 0) {
        sentence = await askLink(item, paragraph, found.join(" "));
        found = linkProblems(item, paragraph, sentence);
      }
      return found.length === 0 && sentence !== "" ? sentence : null;
    } catch (err) {
      if (!(err instanceof OllamaOutputError || err instanceof OllamaTimeoutError)) throw err;
      return null;
    }
  };

  const paragraphs: CoverLetterLlmOutput["paragraphs"] = [];
  const usedFacts: string[] = [];
  let skippedBodies = 0;
  let unlinked = 0;

  for (const item of items) {
    const written = await write(item);
    if (item.kind === "opening") {
      if (written !== null && written.problems.length === 0) {
        paragraphs.push({ text: written.text, evidence: item.evidence });
        openingText = written.text;
      } else {
        // The opening is the most visible paragraph: when the model could not get it clean, use the
        // candidate's own first sentence instead of a flagged one.
        notes.push("The opening paragraph was built from your own summary, because the AI's version did not pass the checks.");
        const own = firstSentence(item.facts);
        const fallback = `I am applying for the ${title} role at ${company}. ${own}`.trim();
        paragraphs.push({ text: fallback, evidence: item.evidence });
        openingText = fallback;
      }
      usedFacts.push(item.facts);
      continue;
    }
    if (written === null) {
      skippedBodies += 1;
      continue;
    }
    const link = await writeLink(item, written.text);
    if (link === null && item.need !== "") unlinked += 1;
    paragraphs.push({ text: link === null ? written.text : `${written.text} ${link}`, evidence: item.evidence });
    usedFacts.push(item.facts);
  }

  if (summary === null) {
    paragraphs.unshift({ text: `I am applying for the ${title} role at ${company}.`, evidence: [], noEvidenceNeeded: true });
  }
  if (picks.length === 0) {
    notes.push("No achievement line of your CV touches this job closely enough to build a paragraph from. Add your own.");
  } else if (skippedBodies > 0) {
    notes.push(`The AI gave no usable paragraph for ${skippedBodies} of ${picks.length} achievements, so they are left out. Add them by hand or try again.`);
  }

  if (unlinked > 0) {
    notes.push(`${unlinked} paragraph${unlinked === 1 ? " has" : "s have"} no sentence tying it to the role, because the AI's version did not pass the checks. Add one in your own words.`);
  }

  paragraphs.push({
    text: `I would welcome the chance to discuss how this experience could support the ${title} role at ${company}.`,
    evidence: [],
    noEvidenceNeeded: true,
  });

  const coverage = coverRequirements(options.job.requirements, usedFacts, cvLines);
  return {
    output: {
      greeting: DEFAULT_GREETING,
      paragraphs,
      closing: DEFAULT_CLOSING,
      requirementsAddressed: coverage.addressed,
      gaps: coverage.gaps,
    },
    model,
    calls,
    notes,
  };
}

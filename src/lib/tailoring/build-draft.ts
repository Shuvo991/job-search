/**
 * Turns the raw model output into the drafts shown in the Review & Edit screen, applying every
 * guardrail from guardrails.ts on the way. The model's output is treated as UNTRUSTED:
 *
 *  - bullets are referenced by CV line number, so the "original" is always the user's own line;
 *  - a rewrite that adds numbers, tools or names the CV does not contain is rejected: the editor
 *    starts with the user's original wording and shows why (the AI version stays one click away);
 *  - employers, titles, institutions, locations, dates and skills must appear in the CV, otherwise
 *    they are blanked (or dropped) and reported, never silently kept;
 *  - contact details come from the CV text, not from the model.
 *
 * Pure function of (model output, CV text): easy to test without Ollama.
 */
import { sanitizeInline } from "@/lib/sanitize";
import { extractContact } from "@/lib/tailoring/contact";
import { SUMMARY_HEADING, extractCvSkills, findSection, orderSkillsForJob } from "@/lib/tailoring/cv-sections";
import { findCliches, findScopeClaims } from "@/lib/tailoring/letter-checks";
import { isHeadingLine } from "@/lib/tailoring/reflow";
import { applyScoreGuard } from "@/lib/tailoring/score-guard";
import {
  areDatesNearEntry,
  buildSourceIndex,
  checkRewrittenText,
  findNewNumbers,
  findNewTerms,
  isFieldInSource,
  normalizeForMatch,
  snapToSource,
  wordCount,
  type SourceIndex,
} from "@/lib/tailoring/guardrails";
import type {
  AdditionalDraft,
  CoverLetterDraft,
  CvDraft,
  EducationDraft,
  ExperienceDraft,
  LetterParagraphDraft,
  TextDraft,
} from "@/lib/tailoring/types";
import type { CoverLetterLlmOutput, CvLlmOutput } from "@/schemas/tailoring";

export interface BuildResult<T> {
  draft: T;
  warnings: string[];
}

const LEADING_NOISE = /^[\s•·▪●◦■□►▶➢✓*\-–—>#]+/u;

/** Single-line plain text: markup, markdown emphasis, bullet glyphs and control characters removed. */
export function cleanLine(text: string, max: number): string {
  return sanitizeInline(text)
    .replace(/\*\*|__|`/g, "")
    .replace(LEADING_NOISE, "")
    .trim()
    .slice(0, max);
}

/** Paragraph text: like cleanLine but keeps the model's sentences intact (still a single line). */
function cleanParagraph(text: string, max: number): string {
  return sanitizeInline(text).replace(/\*\*|__|`/g, "").trim().slice(0, max);
}

function shorten(text: string, max = 70): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sameText(a: string, b: string): boolean {
  return normalizeForMatch(a) === normalizeForMatch(b);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function uniqueCapped(values: readonly string[], max: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanLine(value, maxChars);
    const key = cleaned.toLowerCase();
    if (cleaned === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= max) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// CV
// ---------------------------------------------------------------------------

export interface JobContext {
  title: string;
  description: string;
  skills: readonly string[];
  requirements: readonly string[];
}

const MAX_SUMMARY_LINES = 8;
/** A date range such as "Jan 2021 - Present", "Apr 2021 - Aug 2026" or "2018 – 2020" marks a job header, not a bullet. */
const DATE_RANGE = /\b(?:19|20)\d{2}\b\s*(?:[-–—]|to)\s*(?:(?:[a-z]{3,9}\.?\s+)?(?:19|20)\d{2}|present|current|now)\b/i;

/** The CV line a model refers to by number, or null for a number that is not a line. */
function lineText(source: SourceIndex, value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const id = Math.round(value);
  return source.lines[id - 1]?.raw ?? null;
}

/**
 * The candidate's own summary text: the CV's summary section (found by its heading), else the lines the
 * model pointed at. Null when the CV has no summary.
 */
export function resolveSummaryOriginal(summaryLines: readonly number[], source: SourceIndex): string | null {
  const cvLines = source.lines.map((line) => line.raw);
  const section = findSection(cvLines, SUMMARY_HEADING);
  let original: string | null = null;
  if (section && section.lines.length > 0) {
    original = section.lines.slice(0, MAX_SUMMARY_LINES).join(" ");
  } else {
    const picked: string[] = [];
    const seen = new Set<number>();
    for (const value of summaryLines.slice(0, MAX_SUMMARY_LINES)) {
      const text = lineText(source, value);
      const id = Math.round(value);
      if (text === null || seen.has(id) || isHeadingLine(text)) continue;
      seen.add(id);
      picked.push(text);
    }
    if (picked.length > 0) original = picked.join(" ");
  }
  if (original === null) return null;
  const cleaned = cleanLine(original, 2_000);
  return cleaned === "" ? null : cleaned;
}

export function looksLikeHeader(line: string): boolean {
  return isHeadingLine(line) || (line.length < 110 && DATE_RANGE.test(line));
}

export function buildCvDraft(output: CvLlmOutput, cvText: string, job?: JobContext): BuildResult<CvDraft> {
  const warnings: string[] = [];
  const source = buildSourceIndex(cvText);
  const cvLines = source.lines.map((line) => line.raw);

  // Contact: from the CV text. The model may only supply a name or location that the CV also contains.
  const contact = extractContact(cvText);
  const aiName = cleanLine(output.fullName, 120);
  if (aiName.length >= 3 && isFieldInSource(aiName, source)) contact.fullName = aiName;
  const aiLocation = cleanLine(output.location, 160);
  if (aiLocation !== "" && isFieldInSource(aiLocation, source)) contact.location = aiLocation;

  // Summary: the CV's own summary section (found by its heading), else the lines the model points at.
  const summaryOriginal = resolveSummaryOriginal(output.summary.lines, source);
  const summarySuggested = cleanParagraph(output.summary.tailored, 1_500);
  const summaryFlags =
    summarySuggested === "" || (summaryOriginal !== null && sameText(summarySuggested, summaryOriginal))
      ? []
      : checkRewrittenText({ original: summaryOriginal, suggested: summarySuggested, source, numberSources: [cvText] });
  const summary: TextDraft = {
    id: "summary",
    original: summaryOriginal,
    suggested: summarySuggested,
    text: summaryFlags.length > 0 ? (summaryOriginal ?? "") : summarySuggested,
    flags: summaryFlags,
  };

  // Skills: the CV's own skills, in the CV's wording, with the ones this job mentions first.
  const jobText = job ? [job.title, ...job.requirements, job.description].join("\n") : "";
  const skills = orderSkillsForJob(
    extractCvSkills(cvLines).map((skill) => cleanLine(skill, 80)).filter((skill) => skill !== ""),
    jobText,
    job?.skills ?? [],
  ).slice(0, 60);

  // Experience
  const experience: ExperienceDraft[] = [];
  const usedLines = new Set<number>();
  const unmatchedBullets: string[] = [];
  const droppedEntries: string[] = [];
  let rejectedRewrites = 0;

  for (const entry of output.experience.slice(0, 20)) {
    const entryId = `exp-${experience.length}`;
    const company = cleanLine(entry.company, 200);
    const title = cleanLine(entry.title, 200);
    const companyOk = company !== "" && isFieldInSource(company, source);
    const titleOk = title !== "" && isFieldInSource(title, source);

    const bullets: TextDraft[] = [];
    for (const pair of entry.bullets.slice(0, 20)) {
      const id = Math.round(pair.line);
      const line = lineText(source, pair.line);
      if (line === null) {
        const attempted = cleanLine(pair.tailored, 200);
        if (attempted !== "") unmatchedBullets.push(attempted);
        continue;
      }
      if (usedLines.has(id) || looksLikeHeader(line)) continue;
      usedLines.add(id);

      const original = cleanLine(line, 1_200);
      if (original === "") continue;
      const suggested = cleanLine(pair.tailored, 700) || original;
      const flags = sameText(suggested, original)
        ? []
        : checkRewrittenText({ original, suggested, source, numberSources: [original], keepDetail: true });
      if (flags.length > 0) rejectedRewrites += 1;
      bullets.push({
        id: `${entryId}-b${bullets.length}`,
        original,
        suggested,
        text: flags.length > 0 ? original : suggested,
        flags,
      });
    }

    const named = company !== "" || title !== "";
    if (bullets.length === 0 && (!named || (!companyOk && !titleOk))) {
      if (named) droppedEntries.push(company || title);
      continue;
    }

    const issues: string[] = [];
    if (company !== "" && !companyOk) {
      issues.push(`The company “${shorten(company)}” is not in your CV, so it was left blank. Please enter it.`);
    }
    if (title !== "" && !titleOk) {
      issues.push(`The job title “${shorten(title)}” is not in your CV, so it was left blank. Please enter it.`);
    }

    const anchors = [companyOk ? company : "", titleOk ? title : ""].filter((anchor) => anchor !== "");
    const location = cleanLine(entry.location, 160);
    const locationOk = location !== "" && isFieldInSource(location, source);
    const startDate = cleanLine(entry.startDate, 40);
    const endDate = cleanLine(entry.endDate, 40);
    const startOk = startDate !== "" && areDatesNearEntry(startDate, source, anchors);
    const endOk = endDate !== "" && areDatesNearEntry(endDate, source, anchors);
    if (startDate !== "" && !startOk) {
      issues.push(`The start date “${shorten(startDate)}” does not match your CV, so it was left blank. Please enter it.`);
    }
    if (endDate !== "" && !endOk) {
      issues.push(`The end date “${shorten(endDate)}” does not match your CV, so it was left blank. Please enter it.`);
    }

    experience.push({
      id: entryId,
      title: titleOk ? title : "",
      company: companyOk ? company : "",
      location: locationOk ? location : "",
      startDate: startOk ? startDate : "",
      endDate: endOk ? endDate : "",
      issues,
      bullets,
    });
  }

  // Education
  const education: EducationDraft[] = [];
  const droppedEducation: string[] = [];
  const unmatchedDegrees: string[] = [];
  for (const entry of output.education.slice(0, 12)) {
    const institution = cleanLine(entry.institution, 200);
    if (institution === "") continue;
    if (!isFieldInSource(institution, source)) {
      droppedEducation.push(institution);
      continue;
    }
    const degree = cleanLine(entry.degree, 250);
    const degreeOk = degree !== "" && isFieldInSource(degree, source);
    if (degree !== "" && !degreeOk) unmatchedDegrees.push(degree);
    const startDate = cleanLine(entry.startDate, 40);
    const endDate = cleanLine(entry.endDate, 40);
    education.push({
      id: `edu-${education.length}`,
      institution,
      degree: degreeOk ? degree : "",
      startDate: startDate !== "" && areDatesNearEntry(startDate, source, [institution]) ? startDate : "",
      endDate: endDate !== "" && areDatesNearEntry(endDate, source, [institution]) ? endDate : "",
    });
  }

  // Additional sections: the CV's own lines, picked by line number.
  const additional: AdditionalDraft[] = [];
  let droppedItems = 0;
  for (const section of output.additional.slice(0, 8)) {
    const heading = cleanLine(section.heading, 80);
    const items: string[] = [];
    for (const value of section.lines.slice(0, 30)) {
      const line = lineText(source, value);
      if (line === null) {
        droppedItems += 1;
        continue;
      }
      if (isHeadingLine(line)) continue;
      const text = cleanLine(line, 400);
      if (text !== "" && !items.some((existing) => sameText(existing, text))) items.push(text);
    }
    if (heading !== "" && items.length > 0) additional.push({ id: `add-${additional.length}`, heading, items });
  }

  // Warnings, most important first.
  if (experience.length === 0) {
    warnings.unshift(
      "No work experience could be matched to your CV. Check that the pasted text is complete, or try a larger model.",
    );
  }
  if (unmatchedBullets.length > 0) {
    warnings.push(
      `${plural(unmatchedBullets.length, "AI bullet", "AI bullets")} referred to a CV line that does not exist and ${
        unmatchedBullets.length === 1 ? "was" : "were"
      } left out: ${unmatchedBullets
        .slice(0, 3)
        .map((text) => `“${shorten(text)}”`)
        .join(", ")}${unmatchedBullets.length > 3 ? ", …" : ""}. Add them back by hand if they are real.`,
    );
  }
  if (droppedEntries.length > 0) {
    warnings.push(`Left out experience entries that are not in your CV: ${droppedEntries.slice(0, 5).join(", ")}.`);
  }
  if (droppedEducation.length > 0) {
    warnings.push(`Left out education entries that are not in your CV: ${droppedEducation.slice(0, 5).join(", ")}.`);
  }
  if (unmatchedDegrees.length > 0) {
    warnings.push(`Degree names left blank because they do not match your CV: ${unmatchedDegrees.slice(0, 5).join(", ")}.`);
  }
  if (droppedItems > 0) {
    warnings.push(`${plural(droppedItems, "line", "lines")} in other sections did not match your CV and ${droppedItems === 1 ? "was" : "were"} left out.`);
  }
  const rejected = rejectedRewrites + (summaryFlags.length > 0 ? 1 : 0);
  if (rejected > 0) {
    warnings.push(
      `${plural(rejected, "AI rewrite was", "AI rewrites were")} held back by the safety checks (new numbers, tools or names, or lost numbers and detail). Your original wording is in the editor; the AI version is one click away.`,
    );
  }

  const matchedKeywords = uniqueCapped(output.matchedKeywords, 40, 60)
    .filter((keyword) => isFieldInSource(keyword, source))
    .slice(0, 25);

  const draft: CvDraft = {
    contact,
    summary,
    skills,
    experience,
    education,
    additional,
    matchedKeywords,
    gaps: uniqueCapped(output.gaps, 10, 200),
    notes: uniqueCapped(output.notes, 4, 240),
  };

  // Last gate: an AI rewrite is only applied when it does not lower the ATS match for this job.
  if (job) {
    const guard = applyScoreGuard(draft, job.skills);
    if (guard.heldBack > 0) {
      warnings.push(
        `${plural(guard.heldBack, "AI rewrite was", "AI rewrites were")} not applied because ${
          guard.heldBack === 1 ? "it" : "each"
        } would have lowered your ATS match for this job. Your wording is in the editor; the AI version is one click away.`,
      );
    }
  }

  return { draft, warnings };
}

// ---------------------------------------------------------------------------
// Cover letter
// ---------------------------------------------------------------------------

export const DEFAULT_GREETING = "Dear Hiring Team,";
export const DEFAULT_CLOSING = "Thank you for your time and consideration.";
const MAX_PARAGRAPHS = 6;
const IDEAL_MAX_WORDS = 380;

export interface LetterJob {
  title: string;
  company: string;
}

export function buildCoverLetterDraft(
  output: CoverLetterLlmOutput,
  cvText: string,
  job: LetterJob,
): BuildResult<CoverLetterDraft> {
  const warnings: string[] = [];
  const source = buildSourceIndex(cvText);
  // The job title and company name are the only outside names a letter may use.
  const jobNames: SourceIndex = buildSourceIndex(`${job.title}\n${job.company}`);

  const contact = extractContact(cvText);

  const cleaned = output.paragraphs
    .map((paragraph) => ({
      text: cleanParagraph(paragraph.text, 2_500),
      evidence: paragraph.evidence,
      exempt: paragraph.noEvidenceNeeded === true,
    }))
    .filter((paragraph) => paragraph.text !== "")
    .slice(0, MAX_PARAGRAPHS);

  const paragraphs: LetterParagraphDraft[] = cleaned.map((paragraph, index) => {
    const flags: string[] = [];

    const evidence: string[] = [];
    for (const rawLine of paragraph.evidence.slice(0, 6)) {
      const line = cleanLine(rawLine, 500);
      // Evidence is one achievement or responsibility line (a job header proves nothing).
      if (line === "" || looksLikeHeader(line)) continue;
      const snap = snapToSource(line, source, { maxWindow: 1 });
      if (snap && looksLikeHeader(snap.text)) continue;
      if (snap && !evidence.some((existing) => sameText(existing, snap.text))) evidence.push(snap.text);
      if (evidence.length >= 3) break;
    }

    // The last of three or more paragraphs is the closing call to action and needs no evidence.
    const isClosing = cleaned.length >= 3 && index === cleaned.length - 1;
    if (evidence.length === 0 && !isClosing && !paragraph.exempt) {
      flags.push("No line of your CV backs up this paragraph. Check every claim in it.");
    }

    const numbers = findNewNumbers(paragraph.text, [cvText]);
    if (numbers.length > 0) flags.push(`Contains a number that is not in your CV: ${numbers.join(", ")}.`);

    const terms = findNewTerms(paragraph.text, source, { alsoAllowed: jobNames });
    if (terms.length > 0) flags.push(`Mentions something your CV does not: ${terms.join(", ")}.`);

    if (/\[[^\]\n]{1,40}\]/.test(paragraph.text)) flags.push("Contains a [placeholder] that needs real text.");

    const cliches = findCliches(paragraph.text);
    if (cliches.length > 0) {
      flags.push(`Sounds like a template: ${cliches.map((phrase) => `“${phrase}”`).join(", ")}. Say what you did instead.`);
    }
    // Only where there is a CV line to compare with (the closing paragraph has none).
    const claims = evidence.length > 0 ? findScopeClaims(paragraph.text, evidence) : [];
    if (claims.length > 0) {
      flags.push(`Says “${claims.join("”, “")}”, which the CV line beside it does not. Check that it is true.`);
    }

    return { id: `para-${index}`, text: paragraph.text, evidence, flags };
  });

  const greetingRaw = cleanLine(output.greeting, 80);
  const greeting = greetingRaw === "" || /[[\]]/.test(greetingRaw) ? DEFAULT_GREETING : greetingRaw;
  const closingRaw = cleanLine(output.closing, 200);
  const closing = closingRaw === "" || /[[\]]/.test(closingRaw) ? DEFAULT_CLOSING : closingRaw;

  if (paragraphs.length === 0) {
    warnings.push("The AI did not produce any paragraphs. Try again, or switch to a larger model.");
  }
  const flagged = paragraphs.filter((paragraph) => paragraph.flags.length > 0).length;
  if (flagged > 0) {
    warnings.push(
      `${plural(flagged, "paragraph needs", "paragraphs need")} a careful check: the safety checks found claims that your CV does not back up. Edit or delete them before you export.`,
    );
  }
  const words = paragraphs.reduce((total, paragraph) => total + wordCount(paragraph.text), 0);
  if (words > IDEAL_MAX_WORDS) {
    warnings.push(`The letter is ${words} words. One page is about 250 to 350 words; consider shortening it.`);
  }

  return {
    draft: {
      contact,
      greeting,
      paragraphs,
      closing,
      requirementsAddressed: uniqueCapped(output.requirementsAddressed, 10, 200),
      gaps: uniqueCapped(output.gaps, 10, 200),
    },
    warnings,
  };
}

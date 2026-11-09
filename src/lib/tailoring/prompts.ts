/**
 * Loads the coach prompts from config/prompts/*.md (editable without code changes) and builds the
 * user message that carries the two untrusted documents: the job posting and the CV.
 *
 * Prompts are read on every request, so an edited prompt takes effect without a restart. The file
 * name and a content hash travel with each generation (GenerationMeta) for traceability.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JobView } from "@/lib/jobs/repository";
import { buildSourceIndex } from "@/lib/tailoring/guardrails";

export type PromptName = "cv-coach" | "bullet-coach" | "cover-letter";

export interface LoadedPrompt {
  name: PromptName;
  /** Repository-relative file name, e.g. "config/prompts/cv-coach.md". */
  file: string;
  /** The text sent to the model (HTML comments, which are notes for humans, are removed). */
  text: string;
  /** First 16 hex characters of the SHA-256 of the file content. */
  hash: string;
}

const PROMPT_FILES: Record<PromptName, string> = {
  "cv-coach": "cv-coach.md",
  "bullet-coach": "bullet-coach.md",
  "cover-letter": "cover-letter.md",
};

export function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export async function loadPrompt(name: PromptName): Promise<LoadedPrompt> {
  const fileName = PROMPT_FILES[name];
  const raw = await readFile(path.join(process.cwd(), "config", "prompts", fileName), "utf8");
  return {
    name,
    file: `config/prompts/${fileName}`,
    text: stripHtmlComments(raw),
    hash: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

/** The description is capped so a very long posting cannot push the CV out of the context window. */
export const MAX_DESCRIPTION_CHARS = 6_000;
const MAX_REQUIREMENTS = 12;
const MAX_REQUIREMENT_CHARS = 300;

export type PromptJob = Pick<
  JobView,
  "title" | "company" | "location" | "country" | "workMode" | "seniority" | "description" | "skills" | "requirements"
>;

/** Untrusted text must not be able to close the delimiter blocks and "escape" into the instructions. */
export function neutralizeDelimiters(text: string): string {
  return text.replace(/<\/?\s*(?:job_posting|candidate_cv|job|item)\s*>/gi, "");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return `${(lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n[posting shortened]`;
}

export function formatJobForPrompt(job: PromptJob): string {
  const place = [job.location, job.country].filter((part): part is string => Boolean(part)).join(", ");
  const lines = [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    place ? `Location: ${place}` : "",
    job.workMode !== "UNKNOWN" ? `Work mode: ${job.workMode.toLowerCase()}` : "",
    job.seniority !== "UNKNOWN" ? `Seniority: ${job.seniority.toLowerCase()}` : "",
    job.skills.length > 0 ? `Key skills: ${job.skills.slice(0, 30).join(", ")}` : "",
  ].filter((line) => line !== "");

  const requirements = job.requirements
    .slice(0, MAX_REQUIREMENTS)
    .map((requirement) => `- ${requirement.slice(0, MAX_REQUIREMENT_CHARS)}`);
  if (requirements.length > 0) lines.push("Requirements:", ...requirements);

  lines.push("Description:", truncate(job.description, MAX_DESCRIPTION_CHARS));
  return neutralizeDelimiters(lines.join("\n"));
}

function documents(job: PromptJob, cvText: string): string {
  return [
    "<job_posting>",
    formatJobForPrompt(job),
    "</job_posting>",
    "",
    "<candidate_cv>",
    neutralizeDelimiters(cvText),
    "</candidate_cv>",
  ].join("\n");
}

/**
 * The CV as numbered lines, "[12] text". The model answers with these numbers instead of copying text
 * back, and build-draft.ts resolves them against the same table (SourceIndex.lines, 1-based).
 */
export function numberCvLines(cvText: string): string {
  return buildSourceIndex(cvText)
    .lines.map((line, index) => `[${index + 1}] ${line.raw}`)
    .join("\n");
}

export function buildCvUserMessage(job: PromptJob, cvText: string): string {
  return `${documents(job, numberCvLines(cvText))}\n\nMap this CV and compare it with this job. Follow the rules exactly. Refer to CV lines by their [number]. Return the JSON object now.`;
}

const MAX_KEYWORDS = 15;
const MAX_KEYWORD_CHARS = 40;

/**
 * The short, per-job block shared by every rewrite call. It is the same text for all bullets of a run
 * and is sent FIRST in the user message, so Ollama can reuse the already-processed prompt prefix.
 */
export function formatJobBrief(job: Pick<PromptJob, "title" | "company" | "skills">): string {
  const keywords = job.skills
    .map((skill) => skill.trim().slice(0, MAX_KEYWORD_CHARS))
    .filter((skill) => skill !== "")
    .slice(0, MAX_KEYWORDS);
  return [
    "<job>",
    `Title: ${neutralizeDelimiters(job.title)}`,
    `Company: ${neutralizeDelimiters(job.company)}`,
    keywords.length > 0 ? `Keywords: ${neutralizeDelimiters(keywords.join(", "))}` : "",
    "</job>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export interface RewriteRequest {
  kind: "bullet" | "summary";
  original: string;
  /** "Senior Product Manager at Acme AB", or "" for the summary. */
  role: string;
  /** Set on the second try: what was wrong with the first rewrite. */
  feedback?: string | undefined;
}

export function buildRewriteUserMessage(job: Pick<PromptJob, "title" | "company" | "skills">, request: RewriteRequest): string {
  const lines = [
    formatJobBrief(job),
    "",
    request.kind === "summary" ? "Candidate's summary:" : `Candidate's bullet${request.role !== "" ? ` (role: ${request.role})` : ""}:`,
    "<item>",
    neutralizeDelimiters(request.original),
    "</item>",
    "",
  ];
  if (request.feedback !== undefined && request.feedback !== "") {
    lines.push(
      `Your previous rewrite was rejected: ${neutralizeDelimiters(request.feedback)} Rewrite it again and fix exactly that. Keep every number and name of the original.`,
      "",
    );
  }
  lines.push(
    request.kind === "summary"
      ? 'Rewrite the summary for this job. Follow the rules exactly. Return {"rewrite": "..."} now.'
      : 'Rewrite this bullet for this job. Follow the rules exactly. Return {"rewrite": "..."} now.',
  );
  return lines.join("\n");
}

const MAX_LETTER_NEEDS = 3;
const MAX_NEED_CHARS = 140;

export interface LetterParagraphRequest {
  kind: "opening" | "body";
  /** The fact base: the candidate's summary (opening) or one achievement line (body). */
  facts: string;
  /** The job header above the achievement line, for the employer and title. */
  context: readonly string[];
  /** Set on the second try: what was wrong with the first paragraph. */
  feedback?: string | undefined;
}

/**
 * One cover letter paragraph. The job block comes first and is the same for every paragraph of a run
 * (so Ollama can reuse the processed prompt prefix); the single fact base comes last.
 */
export function buildLetterParagraphMessage(
  job: Pick<PromptJob, "title" | "company" | "requirements">,
  request: LetterParagraphRequest,
): string {
  const needs = job.requirements
    .map((requirement) => requirement.trim().slice(0, MAX_NEED_CHARS))
    .filter((requirement) => requirement !== "")
    .slice(0, MAX_LETTER_NEEDS);
  const lines = [
    "<job>",
    `Title: ${neutralizeDelimiters(job.title)}`,
    `Company: ${neutralizeDelimiters(job.company)}`,
    request.kind === "opening" && needs.length > 0 ? `The role needs: ${neutralizeDelimiters(needs.join("; "))}` : "",
    "</job>",
    "",
    request.kind === "opening" ? "Candidate's own summary:" : "Candidate's achievement:",
  ].filter((line, index) => line !== "" || index === 5);
  if (request.kind === "body" && request.context.length > 0) {
    lines.push(`Heading in the CV: ${neutralizeDelimiters(request.context.join(" | "))}`);
  }
  lines.push("<item>", neutralizeDelimiters(request.facts), "</item>", "");
  if (request.feedback !== undefined && request.feedback !== "") {
    lines.push(
      `Your previous paragraph was rejected: ${neutralizeDelimiters(request.feedback)} Write it again and fix exactly that. Use only the facts above.`,
      "",
    );
  }
  lines.push(
    request.kind === "opening"
      ? 'Write the opening paragraph. Follow the rules exactly. Return {"paragraph": "..."} now.'
      : 'Write one body paragraph. Follow the rules exactly. Return {"paragraph": "..."} now.',
  );
  return lines.join("\n");
}

export interface LetterLinkRequest {
  /** The finished body paragraph. */
  paragraph: string;
  /** The requirement of the role it speaks to. */
  need: string;
  feedback?: string | undefined;
}

/** The one sentence that says why a finished body paragraph matters for a need of the role. */
export function buildLetterLinkMessage(job: Pick<PromptJob, "title" | "company">, request: LetterLinkRequest): string {
  const lines = [
    "<job>",
    `Title: ${neutralizeDelimiters(job.title)}`,
    `Company: ${neutralizeDelimiters(job.company)}`,
    "</job>",
    "",
    "Finished paragraph:",
    "<item>",
    neutralizeDelimiters(request.paragraph),
    "</item>",
    "",
    `The need of the role: ${neutralizeDelimiters(request.need.slice(0, 160))}`,
    "",
  ];
  if (request.feedback !== undefined && request.feedback !== "") {
    lines.push(
      `Your previous sentence was rejected: ${neutralizeDelimiters(request.feedback)} Write it again and fix exactly that.`,
      "",
    );
  }
  lines.push('Write the link sentence. Follow the rules exactly. Return {"sentence": "..."} now.');
  return lines.join("\n");
}

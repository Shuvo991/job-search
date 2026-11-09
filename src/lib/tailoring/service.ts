/**
 * Orchestrates one generation: prompt file -> local model (structured JSON) -> guardrails -> draft.
 * The API routes stay thin and this stays testable with a mocked Ollama client.
 */
import type { JobView } from "@/lib/jobs/repository";
import { UnprocessableEntityError } from "@/lib/errors";
import { generateStructured } from "@/lib/ollama-client";
import { countWords, normalizeResumeText } from "@/lib/resume/text";
import { buildCoverLetterDraft, buildCvDraft } from "@/lib/tailoring/build-draft";
import { reflowCvText } from "@/lib/tailoring/reflow";
import { composeLetter } from "@/lib/tailoring/letter-runner";
import { mergeRewrites, planRewrites } from "@/lib/tailoring/rewrite-plan";
import { runRewrites, type RewriteProgress } from "@/lib/tailoring/rewrite-runner";
import {
  buildCvUserMessage,
  loadPrompt,
} from "@/lib/tailoring/prompts";
import type { CoverLetterResponse, TailorCvResponse } from "@/lib/tailoring/types";
import { cvStructureSchema } from "@/schemas/tailoring";

/** A real CV is far longer; this only catches an empty or accidental paste. */
export const MIN_CV_WORDS = 30;

export interface GenerationInput {
  job: JobView;
  resumeText: string;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Normalise the pasted/uploaded CV text (control and bidi characters removed), sanity-check it and
 * re-join lines that a PDF wrapped in the middle of a bullet.
 */
export function prepareResumeText(raw: string): string {
  const text = normalizeResumeText(raw);
  if (countWords(text) < MIN_CV_WORDS) {
    throw new UnprocessableEntityError(
      `The CV text is too short to tailor (at least ${MIN_CV_WORDS} words are needed). Paste your full CV or upload a PDF or DOCX.`,
      { reason: "cv_too_short" },
    );
  }
  return reflowCvText(text);
}

export type TailorProgress = RewriteProgress;

export interface TailorCvInput extends GenerationInput {
  /** Called as the work moves along ("reading", then "rewriting 5 of 16"). */
  onProgress?: ((progress: TailorProgress) => void) | undefined;
}

/**
 * CV tailoring in two steps, both on the local model:
 *  1. one short call READS the CV (which lines are the summary, the jobs and their bullets);
 *  2. one tiny call per bullet and for the summary REWRITES it, each checked at once and retried once
 *     with the exact reason if a guardrail objects.
 * buildCvDraft then applies every guardrail and the ATS score guard again to the combined result.
 */
export async function tailorCv(input: TailorCvInput): Promise<TailorCvResponse> {
  const startedAt = Date.now();
  const resumeText = prepareResumeText(input.resumeText);
  const readPrompt = await loadPrompt("cv-coach");
  const rewritePrompt = await loadPrompt("bullet-coach");

  input.onProgress?.({ stage: "reading", done: 0, total: 0, label: "" });
  const mapped = await generateStructured({
    system: readPrompt.text,
    user: buildCvUserMessage(input.job, resumeText),
    schema: cvStructureSchema,
    model: input.model,
    signal: input.signal,
  });

  const plan = planRewrites(mapped.data, resumeText);
  const run = await runRewrites({
    job: input.job,
    system: rewritePrompt.text,
    cvText: resumeText,
    targets: plan.targets,
    model: input.model ?? mapped.model,
    signal: input.signal,
    onProgress: input.onProgress,
  });

  const { draft, warnings } = buildCvDraft(
    mergeRewrites(mapped.data, run.rewrites),
    resumeText,
    {
      title: input.job.title,
      description: input.job.description,
      skills: input.job.skills,
      requirements: input.job.requirements,
    },
  );

  // Say plainly what the model could not do, so a missing rewrite is never a mystery.
  if (run.failed > 0 || run.stoppedEarly) {
    warnings.unshift(
      run.stoppedEarly
        ? "The local model stopped answering well, so the bullets it did not reach keep your own wording. Try again, or use a larger model."
        : `The model gave no usable answer for ${run.failed} of ${plan.targets.length} items, so those keep your own wording.`,
    );
  }

  return {
    draft,
    warnings,
    meta: {
      model: run.model ?? mapped.model,
      durationMs: Date.now() - startedAt,
      attempts: mapped.attempts + run.calls,
      promptFile: readPrompt.file,
      promptHash: readPrompt.hash,
    },
  };
}

/**
 * The cover letter in small steps (see letter-runner.ts): code picks the evidence and writes the closing,
 * the model words one fact per call, every paragraph is checked and retried once.
 */
export async function writeCoverLetter(input: GenerationInput): Promise<CoverLetterResponse> {
  const startedAt = Date.now();
  const resumeText = prepareResumeText(input.resumeText);
  const prompt = await loadPrompt("cover-letter");
  const composed = await composeLetter({
    job: input.job,
    system: prompt.text,
    cvText: resumeText,
    model: input.model,
    signal: input.signal,
  });
  const { draft, warnings } = buildCoverLetterDraft(composed.output, resumeText, {
    title: input.job.title,
    company: input.job.company,
  });
  warnings.unshift(...composed.notes);
  return {
    draft,
    warnings,
    meta: {
      model: composed.model ?? "",
      durationMs: Date.now() - startedAt,
      attempts: composed.calls,
      promptFile: prompt.file,
      promptHash: prompt.hash,
    },
  };
}

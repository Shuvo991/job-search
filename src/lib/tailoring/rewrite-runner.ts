/**
 * Step 2 of the local pipeline: rewrite the CV one bullet (and the summary) at a time.
 *
 * Why this is better than "rewrite the whole CV in one answer" for a small local model:
 *  - each call is tiny (about 300 prompt tokens, 30 to 60 output tokens), so a 7B model on a laptop CPU
 *    answers in seconds and cannot lose its place or garble line numbers;
 *  - a bad answer costs one bullet, not the whole CV;
 *  - every answer is checked IMMEDIATELY with the same guardrails the review screen uses, and a rewrite
 *    that drops a number or adds a new term is sent back once with the exact reason. The second try
 *    fixes most of them; if it does not, the rewrite is still handed to buildCvDraft, which holds it
 *    back (the user keeps their own wording) and shows why.
 *
 * Nothing here can add content to the CV: it only produces candidate text. buildCvDraft applies the
 * guardrails and the score guard again before anything reaches the editor.
 */
import type { JobView } from "@/lib/jobs/repository";
import {
  OllamaOutputError,
  OllamaTimeoutError,
  generateStructured,
  getOllamaConfig,
} from "@/lib/ollama-client";
import { cleanLine } from "@/lib/tailoring/build-draft";
import { buildSourceIndex, checkRewrittenText, normalizeForMatch } from "@/lib/tailoring/guardrails";
import { buildRewriteUserMessage } from "@/lib/tailoring/prompts";
import type { RewriteTarget } from "@/lib/tailoring/rewrite-plan";
import { rewriteLlmSchema } from "@/schemas/tailoring";

/** A single bullet should never need longer than this, whatever OLLAMA_TIMEOUT_MS says. */
const MAX_CALL_MS = 180_000;
/** The whole rewriting step stops here; the remaining bullets simply keep the user's wording. */
export const DEFAULT_DEADLINE_MS = 15 * 60_000;
/** Three failures in a row means the model is struggling; stop instead of waiting for more. */
const MAX_CONSECUTIVE_FAILURES = 3;
const BULLET_NUM_PREDICT = 250;
const SUMMARY_NUM_PREDICT = 450;

export type JobBrief = Pick<JobView, "title" | "company" | "skills">;

export interface RewriteProgress {
  stage: "reading" | "rewriting";
  /** Items finished so far. */
  done: number;
  /** Items to rewrite (0 while the CV is still being read). */
  total: number;
  /** A short preview of the item being worked on. */
  label: string;
}

export interface RewriteRunOptions {
  job: JobBrief;
  /** The bullet-coach prompt text. */
  system: string;
  cvText: string;
  targets: readonly RewriteTarget[];
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: RewriteProgress) => void) | undefined;
  deadlineMs?: number | undefined;
  /** For tests: a clock and a stand-in for the model call. */
  now?: () => number;
  generate?: typeof generateStructured;
}

export interface RewriteRunResult {
  /** target.key -> rewritten text. Missing key = keep the user's wording. */
  rewrites: Map<string, string>;
  /** The model that answered, or null when no call was made. */
  model: string | null;
  /** Model calls made (including retries). */
  calls: number;
  /** Rewrites that were sent back once because a guardrail objected. */
  retried: number;
  /** Items where the model gave no usable answer. */
  failed: number;
  /** The run stopped before the last item (deadline, or the model kept failing). */
  stoppedEarly: boolean;
  durationMs: number;
}

function preview(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function runRewrites(options: RewriteRunOptions): Promise<RewriteRunResult> {
  const now = options.now ?? Date.now;
  const generate = options.generate ?? generateStructured;
  const startedAt = now();
  const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const callMs = Math.min(getOllamaConfig().timeoutMs, MAX_CALL_MS);
  const source = buildSourceIndex(options.cvText);

  const rewrites = new Map<string, string>();
  let model: string | null = null;
  let calls = 0;
  let retried = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;

  const ask = async (target: RewriteTarget, feedback?: string): Promise<string> => {
    const result = await generate({
      system: options.system,
      user: buildRewriteUserMessage(options.job, {
        kind: target.kind,
        original: target.original,
        role: target.role,
        feedback,
      }),
      schema: rewriteLlmSchema,
      model: options.model ?? model ?? undefined,
      signal: options.signal,
      temperature: feedback === undefined ? 0.2 : 0.5,
      numPredict: target.kind === "summary" ? SUMMARY_NUM_PREDICT : BULLET_NUM_PREDICT,
      timeoutMs: callMs,
    });
    calls += 1;
    model = result.model;
    return cleanLine(result.data.rewrite, target.kind === "summary" ? 1_500 : 700);
  };

  /** What the guardrails would say about this rewrite (empty = it is fine, or it changes nothing). */
  const problems = (target: RewriteTarget, text: string): string[] => {
    if (text !== "" && normalizeForMatch(text) === normalizeForMatch(target.original)) return [];
    return checkRewrittenText({
      original: target.original,
      suggested: text,
      source,
      numberSources: target.kind === "summary" ? [options.cvText] : [target.original],
      keepDetail: target.kind === "bullet",
    });
  };

  for (const [index, target] of options.targets.entries()) {
    if (now() - startedAt > deadline) {
      stoppedEarly = true;
      break;
    }
    options.onProgress?.({ stage: "rewriting", done: index, total: options.targets.length, label: preview(target.original) });

    try {
      let best = await ask(target);
      let bestProblems = problems(target, best);
      if (bestProblems.length > 0) {
        retried += 1;
        try {
          const second = await ask(target, bestProblems.join(" "));
          const secondProblems = problems(target, second);
          if (secondProblems.length <= bestProblems.length) {
            best = second;
            bestProblems = secondProblems;
          }
        } catch (err) {
          // The retry is a bonus: a slow or garbled second answer keeps the first one.
          if (!(err instanceof OllamaOutputError || err instanceof OllamaTimeoutError)) throw err;
        }
      }
      if (best !== "" && normalizeForMatch(best) !== normalizeForMatch(target.original)) rewrites.set(target.key, best);
      consecutiveFailures = 0;
    } catch (err) {
      // "Ollama is gone", "model missing", "cancelled" and "prompt too long" end the whole run.
      if (!(err instanceof OllamaOutputError || err instanceof OllamaTimeoutError)) throw err;
      failed += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stoppedEarly = true;
        break;
      }
    }
  }

  options.onProgress?.({ stage: "rewriting", done: options.targets.length, total: options.targets.length, label: "" });
  return { rewrites, model, calls, retried, failed, stoppedEarly, durationMs: now() - startedAt };
}

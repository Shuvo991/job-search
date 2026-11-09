"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  ApiRequestError,
  describeError,
  getJson,
  isAbortError,
  parseResumeFile,
  postJson,
  postTailorCv,
  type TailorProgressEvent,
} from "@/components/tailor/api";
import { CvEditor } from "@/components/tailor/cv-editor";
import { LabeledTextarea } from "@/components/tailor/form-controls";
import type { TailorJob } from "@/components/tailor/job-types";
import { LetterEditor } from "@/components/tailor/letter-editor";
import { OllamaFallback } from "@/components/tailor/ollama-fallback";
import { controlClass, hintClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import type { OllamaStatus } from "@/lib/ollama-client";
import { countWords } from "@/lib/resume/text";
import { blankCoverLetterDraft, blankCvDraft } from "@/lib/tailoring/blank";
import type {
  CoverLetterDraft,
  CoverLetterResponse,
  CvDraft,
  GenerationMeta,
} from "@/lib/tailoring/types";

/** The CV text is kept in this browser only (localStorage), never sent anywhere except this app's own API. */
const STORAGE_KEY = "job-search.base-cv";
const MIN_WORDS = 30;
const MAX_CHARS = 100_000;

type Kind = "cv" | "letter";

interface CvResult {
  key: number;
  draft: CvDraft;
  warnings: string[];
  meta: GenerationMeta | null;
  /** The CV text the draft was made from (the "original" column refers to it). */
  sourceText: string;
}

interface LetterResult {
  key: number;
  draft: CoverLetterDraft;
  warnings: string[];
  meta: GenerationMeta | null;
}

interface Problem {
  message: string;
  steps: string[];
  aiUnavailable: boolean;
}

function toProblem(err: unknown): Problem {
  if (err instanceof ApiRequestError) {
    return { message: describeError(err), steps: err.steps, aiUnavailable: err.isAiUnavailable };
  }
  return { message: describeError(err), steps: [], aiUnavailable: false };
}

export function TailorWorkspace({ job }: { job: TailorJob }) {
  // ---- the CV text (kept in this browser only) ----------------------------
  const [resumeText, setResumeText] = useState("");
  const [restored, setRestored] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setResumeText(saved.slice(0, MAX_CHARS));
    } catch {
      // Storage can be unavailable (private mode, blocked); the CV simply is not remembered.
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      if (resumeText === "") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, resumeText);
    } catch {
      // ignore, see above
    }
  }, [resumeText, restored]);

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setUploadNote(null);
    try {
      const parsed = await parseResumeFile(file);
      setResumeText(parsed.text.slice(0, MAX_CHARS));
      setUploadNote(
        `Read ${parsed.fileName}: ${parsed.wordCount} words${parsed.truncated ? " (the file was longer; only the first part was read)" : ""}.`,
      );
    } catch (err) {
      setUploadError(describeError(err));
    } finally {
      setUploading(false);
    }
  }

  // ---- the local AI -------------------------------------------------------
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [model, setModel] = useState("");

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await getJson<OllamaStatus>("/api/ai/status"));
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  // ---- generation ---------------------------------------------------------
  const [busy, setBusy] = useState<Kind | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<TailorProgressEvent | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [cvResult, setCvResult] = useState<CvResult | null>(null);
  const [letterResult, setLetterResult] = useState<LetterResult | null>(null);
  const [tab, setTab] = useState<Kind>("cv");
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    if (busy === null) return undefined;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const words = countWords(resumeText);
  const aiBlocked = status !== null && !status.available;
  const showFallback = aiBlocked || problem?.aiUnavailable === true;
  const canGenerate = words >= MIN_WORDS && busy === null && !showFallback;

  async function generate(kind: Kind) {
    if (busy !== null) return;
    setProblem(null);
    setProgress(null);
    setBusy(kind);
    const controller = new AbortController();
    abortRef.current = controller;
    const sourceText = resumeText;
    const body = { jobId: job.id, resumeText: sourceText, ...(model !== "" ? { model } : {}) };
    try {
      if (kind === "cv") {
        const result = await postTailorCv(body, setProgress, controller.signal);
        keyRef.current += 1;
        setCvResult({ key: keyRef.current, sourceText, ...result });
      } else {
        const result = await postJson<CoverLetterResponse>("/api/documents/cover-letter", body, controller.signal);
        keyRef.current += 1;
        setLetterResult({ key: keyRef.current, ...result });
      }
      setTab(kind);
    } catch (err) {
      if (!isAbortError(err)) {
        const next = toProblem(err);
        setProblem(next);
        if (next.aiUnavailable) void checkStatus();
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
      setBusy(null);
    }
  }

  function writeManually() {
    setProblem(null);
    keyRef.current += 1;
    setCvResult({ key: keyRef.current, draft: blankCvDraft(resumeText), warnings: [], meta: null, sourceText: resumeText });
    keyRef.current += 1;
    setLetterResult({ key: keyRef.current, draft: blankCoverLetterDraft(resumeText), warnings: [], meta: null });
    setTab("cv");
  }

  const installed = status?.installedModels ?? [];
  const hasResults = cvResult !== null || letterResult !== null;

  return (
    <div className="space-y-8">
      {/* ---- 1. the CV ---- */}
      <section aria-labelledby="step-cv-heading" className="space-y-3 rounded-xl border border-neutral-400 bg-neutral-50 p-4">
        <div>
          <h2 id="step-cv-heading" className="text-xl font-semibold">
            1. Your CV
          </h2>
          <p className={hintClass}>
            Upload a PDF or DOCX, or paste the text. It is saved in this browser only, and it is sent only to this app
            on your computer.
          </p>
        </div>

        <div>
          <label htmlFor="cv-file" className={labelClass}>
            Upload a CV file (PDF or DOCX)
          </label>
          <input
            id="cv-file"
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={uploading}
            onChange={onFileChosen}
            className={`${controlClass} mt-1 file:mr-3 file:rounded file:border-0 file:bg-neutral-200 file:px-3 file:py-1 file:font-semibold`}
          />
          <p className="mt-1 text-sm text-neutral-800" aria-live="polite">
            {uploading ? "Reading the file…" : uploadNote}
          </p>
          {uploadError ? (
            <p role="alert" className="mt-1 text-sm font-semibold text-red-800">
              <span aria-hidden="true">⚠ </span>
              {uploadError}
            </p>
          ) : null}
        </div>

        <LabeledTextarea
          id="cv-text"
          label="CV text"
          rows={12}
          value={resumeText}
          onChange={(text) => setResumeText(text.slice(0, MAX_CHARS))}
          maxLength={MAX_CHARS}
          hint="Include every job with its dates and bullets. The AI can only reuse what is written here."
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-neutral-800" aria-live="polite">
            {words} words{words > 0 && words < MIN_WORDS ? ` (at least ${MIN_WORDS} are needed)` : ""}.
          </p>
          {resumeText !== "" ? (
            <button
              type="button"
              className="text-sm font-medium text-indigo-800 underline underline-offset-2 hover:text-indigo-950"
              onClick={() => {
                setResumeText("");
                setUploadNote(null);
              }}
            >
              Forget my CV text
            </button>
          ) : null}
        </div>
      </section>

      {/* ---- 2. generate ---- */}
      <section aria-labelledby="step-ai-heading" className="space-y-3">
        <h2 id="step-ai-heading" className="text-xl font-semibold">
          2. Tailor it with the local AI
        </h2>

        {showFallback ? (
          <OllamaFallback
            status={status}
            {...(problem?.aiUnavailable ? { steps: problem.steps, message: problem.message } : {})}
            checking={checking}
            onCheckAgain={() => {
              setProblem(null);
              void checkStatus();
            }}
            onWriteManually={writeManually}
          />
        ) : (
          <div className="space-y-3 rounded-xl border border-neutral-400 bg-white p-4">
            <p className="text-base text-neutral-900" aria-live="polite">
              {checking
                ? "Checking the local AI…"
                : status?.available
                  ? status.message
                  : "Could not check the local AI. You can still try."}
            </p>

            {installed.length > 1 ? (
              <div className="max-w-sm">
                <label htmlFor="ai-model" className={labelClass}>
                  Model
                </label>
                <select
                  id="ai-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className={`${controlClass} mt-1`}
                >
                  <option value="">Default ({status?.activeModel ?? status?.configuredModel ?? "configured model"})</option>
                  {installed.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <button type="button" className={primaryButtonClass} disabled={!canGenerate} onClick={() => void generate("cv")}>
                {cvResult ? "Tailor my CV again" : "Tailor my CV"}
              </button>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={!canGenerate}
                onClick={() => void generate("letter")}
              >
                {letterResult ? "Write the cover letter again" : "Write a cover letter"}
              </button>
              <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={writeManually}>
                Write it myself (no AI)
              </button>
            </div>
            <p className="text-sm text-neutral-800">
              Nothing is invented: the AI may only rephrase what your CV says, and every result is checked before you
              see it. A CV is rewritten one bullet at a time, so a local model needs a few minutes; you can follow the progress.
            </p>
          </div>
        )}

        {busy !== null ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-700 bg-indigo-50 p-4">
            <p className="text-base font-medium text-neutral-900">
              {busy === "cv" ? "Tailoring your CV" : "Writing your cover letter"} on this computer… {elapsed} s
              {busy === "cv" && progress !== null ? (
                <span className="mt-1 block text-sm font-normal text-neutral-800">
                  {progress.stage === "reading" || progress.total === 0
                    ? "Step 1: reading your CV…"
                    : `Step 2: rewriting item ${Math.min(progress.done + 1, progress.total)} of ${progress.total}${progress.label !== "" ? `: “${progress.label}”` : ""}`}
                </span>
              ) : null}
            </p>
            <button type="button" className={secondaryButtonClass} onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          </div>
        ) : null}

        {problem !== null && !problem.aiUnavailable ? (
          <div role="alert" className="rounded-lg border-2 border-red-700 bg-red-50 p-4 text-base text-neutral-900">
            <p className="font-semibold">
              <span aria-hidden="true">⚠ </span>
              {problem.message}
            </p>
            {problem.steps.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {problem.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ---- 3. review & edit ---- */}
      {hasResults ? (
        <section aria-labelledby="step-review-heading" className="space-y-4">
          <h2 id="step-review-heading" className="text-xl font-semibold">
            3. Review, edit and export
          </h2>

          <div role="tablist" aria-label="Document" className="flex gap-2">
            {(["cv", "letter"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                id={`tab-${kind}`}
                aria-selected={tab === kind}
                aria-controls={`panel-${kind}`}
                className={
                  tab === kind
                    ? "min-h-11 rounded-md bg-indigo-700 px-4 py-2 text-base font-semibold text-white"
                    : "min-h-11 rounded-md border border-neutral-500 bg-white px-4 py-2 text-base font-semibold text-neutral-900 hover:bg-neutral-100"
                }
                onClick={() => setTab(kind)}
              >
                {kind === "cv" ? "CV" : "Cover letter"}
              </button>
            ))}
          </div>

          <div role="tabpanel" id="panel-cv" aria-labelledby="tab-cv" hidden={tab !== "cv"}>
            {cvResult ? (
              <CvEditor
                key={cvResult.key}
                job={job}
                initial={cvResult.draft}
                warnings={cvResult.warnings}
                meta={cvResult.meta}
                originalResumeText={cvResult.sourceText}
                regenerating={busy !== null}
                onRegenerate={() => void generate("cv")}
              />
            ) : (
              <p className="text-base text-neutral-800">
                No tailored CV yet. Press “Tailor my CV” above.
              </p>
            )}
          </div>

          <div role="tabpanel" id="panel-letter" aria-labelledby="tab-letter" hidden={tab !== "letter"}>
            {letterResult ? (
              <LetterEditor
                key={letterResult.key}
                job={job}
                initial={letterResult.draft}
                warnings={letterResult.warnings}
                meta={letterResult.meta}
                regenerating={busy !== null}
                onRegenerate={() => void generate("letter")}
              />
            ) : (
              <p className="text-base text-neutral-800">
                No cover letter yet. Press “Write a cover letter” above.
              </p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

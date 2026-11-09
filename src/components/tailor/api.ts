import type { ParsedResumeResponse } from "@/schemas/resume";
import type { TailorCvResponse, TailorStreamEvent } from "@/lib/tailoring/types";
import type { PdfRequest } from "@/schemas/tailoring";

/** A failed API call, in the project's standard error shape ({ error: { code, message, details } }). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Setup steps the server attached to an "Ollama is not available" error. */
  get steps(): string[] {
    const details = this.details;
    if (typeof details === "object" && details !== null && "steps" in details) {
      const { steps } = details as { steps: unknown };
      if (Array.isArray(steps)) return steps.filter((step): step is string => typeof step === "string");
    }
    return [];
  }

  get isAiUnavailable(): boolean {
    return this.code === "OLLAMA_UNAVAILABLE" || this.code === "OLLAMA_MODEL_MISSING";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function toApiError(res: Response): Promise<ApiRequestError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    return new ApiRequestError(
      res.status,
      body.error?.code ?? "ERROR",
      body.error?.message ?? `The request failed (HTTP ${res.status}).`,
      body.error?.details,
    );
  } catch {
    return new ApiRequestError(res.status, "ERROR", `The request failed (HTTP ${res.status}).`);
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...(signal ? { signal } : {}) });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export type TailorProgressEvent = Extract<TailorStreamEvent, { type: "progress" }>;

/**
 * Tailor the CV and report progress while the local model works ("rewriting 5 of 16"). The server
 * answers with one JSON object per line; the last line is the result or the error. A failure before
 * any work starts (bad request, unknown job) is an ordinary JSON error and is handled as such.
 */
export async function postTailorCv(
  body: unknown,
  onProgress: (event: TailorProgressEvent) => void,
  signal?: AbortSignal,
): Promise<TailorCvResponse> {
  const res = await fetch("/api/documents/tailor-cv", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await toApiError(res);
  if (res.body === null) throw new Error("The server sent an empty answer. Please try again.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: TailorCvResponse | null = null;

  const handle = (line: string) => {
    if (line.trim() === "") return;
    const event = JSON.parse(line) as TailorStreamEvent;
    if (event.type === "progress") onProgress(event);
    else if (event.type === "result") result = event.result;
    else throw new ApiRequestError(502, event.error.code, event.error.message, event.error.details);
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  handle(buffer);

  if (result === null) throw new Error("The connection closed before the CV was ready. Please try again.");
  return result;
}

/** Upload a PDF/DOCX to the existing resume parser and get its plain text back. */
export async function parseResumeFile(file: File): Promise<ParsedResumeResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/resume/parse", { method: "POST", body: form });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ParsedResumeResponse;
}

/** Render the reviewed document to PDF on the server and hand the file to the browser. */
export async function downloadPdf(request: PdfRequest): Promise<void> {
  const res = await fetch("/api/documents/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw await toApiError(res);

  const fileName = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "document.pdf";
  const url = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a moment to start the download before the URL is released.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** One readable sentence (plus up to three field problems) for any error thrown by the helpers above. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiRequestError)) {
    return err instanceof Error ? err.message : "Something went wrong. Please try again.";
  }
  const details = err.details;
  if (Array.isArray(details) && details.length > 0) {
    const lines = details
      .slice(0, 3)
      .map((item) => {
        const { path, message } = item as { path?: unknown; message?: unknown };
        return typeof message === "string" ? `${typeof path === "string" && path !== "" ? `${path}: ` : ""}${message}` : "";
      })
      .filter((line) => line !== "");
    if (lines.length > 0) return `${err.message} (${lines.join("; ")})`;
  }
  return err.message;
}

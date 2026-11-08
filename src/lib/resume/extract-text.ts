/**
 * Plain-text extraction for verified resume files.
 *
 *  - PDF  -> pdf-parse (v2, PDF.js based). Only the first MAX_PDF_PAGES pages are read and the
 *            work is cut off after PARSE_TIMEOUT_MS, so a hostile file cannot pin the server.
 *  - DOCX -> mammoth.extractRawText.
 *
 * Both libraries are imported lazily so the (large) PDF engine is only loaded when a resume is
 * actually uploaded, and so tests can replace them.
 *
 * Callers must have verified the bytes with `detectResumeFileKind` first. This module never
 * touches the disk and never stores the bytes it is given.
 */
import { UnprocessableEntityError } from "@/lib/errors";
import type { ResumeFileKind } from "@/lib/resume/file-signature";

export const MAX_PDF_PAGES = 10;
export const PARSE_TIMEOUT_MS = 20_000;

export interface ExtractedResumeText {
  kind: ResumeFileKind;
  /** Raw extracted text (not yet normalised). */
  text: string;
  /** Total page count when the format reports it (PDF), otherwise undefined. */
  pageCount: number | undefined;
  /** True when pages beyond MAX_PDF_PAGES were skipped. */
  truncated: boolean;
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Zero-fills `view`, unless PDF.js has already taken the memory. Posting a buffer to the PDF.js
 * worker detaches it, and calling fill() on a detached typed array throws a TypeError (it is not a
 * no-op), so the call is guarded. Cleanup must never turn a successful parse into an error.
 */
function wipeIfAttached(view: Uint8Array): void {
  if (view.byteLength === 0) return; // detached (or empty): nothing left to clear
  try {
    view.fill(0);
  } catch {
    // Detached between the check and the call: the memory is no longer ours to clear.
  }
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedResumeText> {
  const { PDFParse } = await import("pdf-parse");

  // PDF.js takes ownership of (and may detach) the buffer it is given, so hand it a private copy.
  const copy = new Uint8Array(bytes);
  const parser = new PDFParse({ data: copy });
  let timedOut = false;
  try {
    const result = await withTimeout(parser.getText({ first: MAX_PDF_PAGES }), PARSE_TIMEOUT_MS, () => {
      timedOut = true;
      return new UnprocessableEntityError("The PDF took too long to read and was stopped");
    });
    const total = typeof result.total === "number" ? result.total : result.pages.length;
    return {
      kind: "pdf",
      text: result.pages.map((page) => page.text).join("\n\n"),
      pageCount: total,
      truncated: total > MAX_PDF_PAGES,
    };
  } catch (error) {
    if (error instanceof UnprocessableEntityError) throw error;
    if (errorName(error) === "PasswordException") {
      throw new UnprocessableEntityError("The PDF is password-protected; remove the password and upload it again");
    }
    throw new UnprocessableEntityError("The PDF could not be read; it may be damaged", undefined, error);
  } finally {
    const destroying = parser.destroy().catch(() => undefined);
    if (!timedOut) await destroying;
    wipeIfAttached(copy);
  }
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractedResumeText> {
  type MammothModule = typeof import("mammoth");
  const imported = (await import("mammoth")) as MammothModule & { default?: MammothModule };
  const mammoth = imported.default ?? imported;

  try {
    // A view over the same memory (no copy), so the caller's wipe() also clears what mammoth read.
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await withTimeout(
      mammoth.extractRawText({ buffer }),
      PARSE_TIMEOUT_MS,
      () => new UnprocessableEntityError("The document took too long to read and was stopped"),
    );
    // mammoth separates paragraphs with blank lines; resumes are scored line by line.
    return { kind: "docx", text: result.value.replace(/\n\n/g, "\n"), pageCount: undefined, truncated: false };
  } catch (error) {
    if (error instanceof UnprocessableEntityError) throw error;
    throw new UnprocessableEntityError("The Word document could not be read; it may be damaged", undefined, error);
  }
}

export async function extractResumeText(bytes: Uint8Array, kind: ResumeFileKind): Promise<ExtractedResumeText> {
  return kind === "pdf" ? extractPdf(bytes) : extractDocx(bytes);
}

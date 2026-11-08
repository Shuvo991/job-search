/**
 * Normalisation for text extracted from a resume (PDF or DOCX).
 *
 * Unlike `sanitizeText` (built for pasted job descriptions) this keeps horizontal whitespace
 * inside a line, because the ATS scorer uses wide gaps and tabs to spot multi-column layouts.
 * It removes everything that is never legitimate in stored text: control characters, bidi
 * overrides ("Trojan Source"), zero-width characters and lone surrogates.
 *
 * Pure and free of Node-only imports, so it can run in the browser too.
 */

/** Resume text beyond this length is ignored; bounds worst-case work on malicious documents. */
export const MAX_RESUME_CHARS = 100_000;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF\u00AD]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
/** Page markers that pdf-parse can insert between pages, e.g. "-- 1 of 2 --". */
const PAGE_MARKER_LINES = /^[ \t]*--[ \t]*\d+[ \t]+of[ \t]+\d+[ \t]*--[ \t]*$/gm;

export function normalizeResumeText(input: string): string {
  return String(input)
    .slice(0, MAX_RESUME_CHARS * 2) // cheap pre-cap before the regex passes
    .normalize("NFC")
    .replace(/\r\n?|\u2028|\u2029|\f/g, "\n")
    .replace(PAGE_MARKER_LINES, "")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .replace(LONE_SURROGATES, "")
    .replace(UNICODE_SPACES, " ")
    .split("\n")
    // trimEnd, not a /[ \t]+$/ regex: that one is quadratic on a very long run of spaces.
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_RESUME_CHARS);
}

/** Number of whitespace-separated words. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

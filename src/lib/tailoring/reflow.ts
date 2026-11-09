/**
 * Rebuilds the CV's real paragraphs and bullets from pasted or PDF-extracted text.
 *
 * Text copied out of a PDF is usually hard-wrapped at a fixed width, so one bullet arrives as two or
 * three short lines. Everything downstream (matching the AI's output to the CV, the "original" column
 * of the review screen) works on whole bullets, so wrapped lines are joined back together first.
 * Pure and deterministic; unit-tested in tests/unit/tailoring-reflow.test.ts.
 */

/** A line that starts a new bullet or list item. */
const BULLET_START = /^(?:[•·▪●◦■□►▶➢✓*]|[-–—]\s)/u;
/** A line that ends a sentence, so the next line starts something new. */
const TERMINAL = /[.!?]["')\]]?$/u;

const KNOWN_HEADING =
  /^(?:(?:professional|work|core|key|technical|relevant|selected)\s+)?(?:summary|profile|experience|skills|competencies|education|certifications?|languages|projects|publications|awards|interests|volunteering|references|expertise|employment|history)(?:\s+(?:summary|experience|history|skills))?\s*:?$/i;

/** "PROFESSIONAL SUMMARY", "Work Experience": a short line that names a section. */
export function isHeadingLine(line: string): boolean {
  const text = line.trim();
  if (text.length < 4 || text.length > 40) return false;
  if (/[|,;]/.test(text)) return false;
  if (KNOWN_HEADING.test(text)) return true;
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && text === text.toUpperCase() && !/\d{4}/.test(text);
}

interface WrapProfile {
  wrapped: boolean;
  /** Lines at least this long are "full" (they were broken because the line ran out of room). */
  fullFrom: number;
}

/** Detect hard wrapping: many lines of nearly the same, maximum length. */
function profileWrapping(lines: readonly string[]): WrapProfile {
  const lengths = lines
    .map((line) => line.length)
    .filter((length) => length >= 40)
    .sort((a, b) => a - b);
  if (lengths.length < 8) return { wrapped: false, fullFrom: Number.POSITIVE_INFINITY };
  const max = lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.95))] ?? 0;
  const cluster = lengths.filter((length) => length >= max * 0.85 && length <= max * 1.1).length;
  const wrapped = cluster >= 5 && cluster / lengths.length >= 0.25;
  return { wrapped, fullFrom: max * 0.8 };
}

/**
 * Join lines that belong to the same bullet or paragraph. A line continues the previous one when the
 * previous line was cut by the wrap width (or the new line starts in lower case) and neither is a
 * heading, a new bullet, or the end of a sentence. Blank lines are kept as paragraph breaks.
 */
export function reflowCvText(raw: string): string {
  const physical = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());
  const profile = profileWrapping(physical);

  const out: string[] = [];
  let lastLength = 0;
  for (const line of physical) {
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      lastLength = 0;
      continue;
    }
    const last = out.length > 0 ? (out[out.length - 1] ?? "") : "";
    const continues =
      last !== "" &&
      !BULLET_START.test(line) &&
      !isHeadingLine(line) &&
      !isHeadingLine(last) &&
      !TERMINAL.test(last) &&
      ((profile.wrapped && lastLength >= profile.fullFrom) || /^\p{Ll}/u.test(line));
    if (continues) out[out.length - 1] = `${last} ${line}`;
    else out.push(line);
    lastLength = line.length;
  }
  return out.join("\n").trim();
}

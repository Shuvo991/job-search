/**
 * The PDF is set in the built-in Helvetica font (no font files to ship, nothing to download, and the
 * text layer is plain and reliably readable by an ATS). Helvetica covers the WinAnsi character set:
 * all of Latin-1 (so Swedish, German, French, Spanish and Nordic letters are fine) plus curly quotes,
 * dashes, the bullet and the euro sign. Anything outside it would be drawn as a missing-glyph box, so
 * this function maps such characters to a close equivalent or drops them.
 *
 * Pure and free of Node-only imports, so the tests (and the browser) can use it.
 */

/** Code points WinAnsi (Windows-1252) adds on top of ASCII and Latin-1. */
const WIN_ANSI_EXTRAS = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e,
  0x0178,
]);

/** Characters outside WinAnsi that have an obvious plain equivalent. Keys are written as escapes. */
const REPLACEMENTS: Readonly<Record<string, string>> = {
  "Ł": "L", // Ł
  "ł": "l", // ł
  "Đ": "D", // Đ
  "đ": "d", // đ
  "Ħ": "H", // Ħ
  "ħ": "h", // ħ
  "ı": "i", // dotless i
  "‐": "-", // hyphen
  "‑": "-", // non-breaking hyphen
  "‒": "-", // figure dash
  "―": "-", // horizontal bar
  "−": "-", // minus sign
  "′": "'", // prime
  "″": '"', // double prime
  "→": "->",
  "←": "<-",
  "≤": "<=",
  "≥": ">=",
  "▪": "•", // small square bullet -> bullet
  "●": "•", // black circle -> bullet
  "◦": "•", // white bullet -> bullet
};

function isRenderable(codePoint: number): boolean {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa1 && codePoint <= 0xff && codePoint !== 0xad) ||
    codePoint === 0xa0 ||
    WIN_ANSI_EXTRAS.has(codePoint)
  );
}

/** Unicode spaces and tabs become a normal space. */
const SPACE_LIKE = /[\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}\t]/u;
/** Zero-width and bidirectional control characters are dropped. */
const ZERO_WIDTH = /[\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{ad}]/u;

export function toPdfText(input: string): string {
  let output = "";
  for (const char of input.normalize("NFC")) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isRenderable(codePoint)) {
      output += char;
      continue;
    }
    if (char === "\n" || char === "\r" || SPACE_LIKE.test(char)) {
      output += " ";
      continue;
    }
    if (ZERO_WIDTH.test(char) || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;

    const replacement = REPLACEMENTS[char];
    if (replacement !== undefined) {
      output += replacement;
      continue;
    }
    // Strip accents ("ő" -> "o", "ś" -> "s"); keep the result only if the PDF font can draw it.
    const base = char.normalize("NFD").replace(/\p{M}/gu, "");
    const baseCodePoint = base.codePointAt(0);
    if (base !== "" && [...base].length === 1 && baseCodePoint !== undefined && isRenderable(baseCodePoint)) {
      output += base;
    }
  }
  return output.replace(/ {2,}/g, " ");
}

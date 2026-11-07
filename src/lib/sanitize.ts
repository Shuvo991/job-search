/**
 * Input sanitisation for pasted job text.
 *
 * Strategy: everything a user pastes (raw HTML from a careers page, text from a PDF, markup with
 * <script> tags) is reduced to PLAIN TEXT before it is stored. The UI then renders that text as
 * text (React escapes it) and never uses dangerouslySetInnerHTML or auto-links it. Two layers, so
 * a bug in one does not become an XSS:
 *   1. here: markup is removed, entities decoded once, control / bidi / zero-width characters dropped
 *   2. at render time: React text escaping + the CSP in next.config.ts
 *
 * Pure functions with no Node-only imports, so the browser can use them for the live preview.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  shy: "",
};

/** Characters that are never legitimate in stored text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Bidirectional overrides/isolates (used for "Trojan Source" style spoofing) and zero-width characters. */
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u061c\ufeff\u00ad]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function isAllowedCodePoint(codePoint: number): boolean {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return false;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  return true;
}

/** Decode named and numeric HTML entities exactly once (no recursive decoding). */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return isAllowedCodePoint(codePoint) ? String.fromCodePoint(codePoint) : "";
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

// Elements whose CONTENT must be dropped too, not just the tags. An unterminated one removes
// everything after it (fail closed).
const DROP_WITH_CONTENT =
  /<(script|style|iframe|object|embed|noscript|template|svg|math|head|title|xml|textarea|noframes|applet|frameset|frame)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;
const CDATA = /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g;
const DECLARATIONS = /<[!?][^>]*>/g;
const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|ul|ol|tr|table|thead|tbody|section|article|h[1-6]|hr|blockquote|pre|header|footer|nav|main|aside|dd|dt|dl|form|fieldset)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const CELL_TAGS = /<\/?(?:td|th)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const ANY_TAG = /<\/?[a-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const STRAY_TAG_START = /<(?=[a-z/!?])/gi;

function stripMarkup(input: string): string {
  let text = input;
  // Repeat until nothing changes: "<scr<script>ipt>" would otherwise reassemble itself.
  for (let pass = 0; pass < 10; pass += 1) {
    const before = text;
    text = text
      .replace(COMMENTS, "")
      .replace(CDATA, "")
      .replace(DROP_WITH_CONTENT, "")
      .replace(DECLARATIONS, "")
      .replace(BLOCK_TAGS, (tag) => (/^<li\b/i.test(tag) ? "\n- " : /^<\/li\b/i.test(tag) ? "" : "\n"))
      .replace(CELL_TAGS, " ")
      .replace(ANY_TAG, "");
    if (text === before) break;
  }
  // Anything still starting like a tag is unterminated; drop the "<" so no tag shape survives.
  return text.replace(STRAY_TAG_START, "");
}

/**
 * Convert untrusted text or HTML into safe multi-line plain text.
 * Paragraph structure is kept (blank lines, bullet lines); everything else is flattened.
 */
export function sanitizeText(input: string): string {
  let text = String(input).normalize("NFC");
  text = text.replace(/\r\n?|\u2028|\u2029/g, "\n");
  // Decode first so entity-encoded markup ("&lt;script&gt;") is treated as markup and removed.
  text = decodeHtmlEntities(text);
  text = stripMarkup(text);
  text = text
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .replace(LONE_SURROGATES, "")
    .replace(/\t/g, " ");

  return text
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Like sanitizeText, but for single-line fields (titles, company, locations, skills). */
export function sanitizeInline(input: string): string {
  return sanitizeText(input).replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
}

/**
 * Parse a URL typed or pasted by a user. Returns the normalised href only for http(s) URLs
 * without embedded credentials; everything else (javascript:, data:, file:, ...) yields undefined.
 */
export function normalizeHttpUrl(input: string): string | undefined {
  const trimmed = sanitizeInline(input);
  if (trimmed === "" || trimmed.length > 2048) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** True when the whole input is nothing but a single URL (a user pasted a link instead of the text). */
export function isLoneUrl(input: string): boolean {
  const trimmed = input.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) && !/\s/.test(trimmed);
}

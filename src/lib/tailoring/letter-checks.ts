/**
 * Two small, deterministic checks for cover letter text that the number/term guardrails cannot make:
 *
 *  - template phrases ("I am excited to apply", "extensive experience", "aligns perfectly") that make a
 *    letter read like every other letter and say nothing;
 *  - scope claims: a strong responsibility verb ("led", "owned", "managed") that the CV line behind the
 *    paragraph does not use. That is how a small model quietly turns "contributed to" into "led".
 *
 * Both are advice, not proof: they feed the one retry in letter-runner.ts and the flags in the editor.
 */

/** Lower-case fragments; a paragraph containing one of them is flagged. */
export const LETTER_CLICHES: readonly string[] = [
  "excited",
  "thrilled",
  "passionate",
  "perfectly",
  "aligns with",
  "aligns well",
  "extensive experience",
  "proven track record",
  "track record",
  "drive sustainable",
  "drive profitable",
  "significant impact",
  "confident that",
  "eager to",
  "hit the ground running",
  "team player",
  "synerg",
  "results-driven",
  "detail-oriented",
  "ideal candidate",
  "perfect fit",
  "great fit",
  "strong fit",
  "i believe",
  "unique blend",
  "wealth of experience",
];

/** The template phrases found in the text (as written in LETTER_CLICHES), without duplicates. */
export function findCliches(text: string): string[] {
  const lower = text.toLowerCase();
  return LETTER_CLICHES.filter((phrase) => lower.includes(phrase));
}

/** Strong responsibility verbs, grouped by what they claim. */
const SCOPE_ROOTS: ReadonlyArray<{ root: string; pattern: RegExp }> = [
  { root: "lead", pattern: /\b(?:led|lead|leads|leading)\b/i },
  { root: "own", pattern: /\b(?:owned|owning)\b/i },
  { root: "spearhead", pattern: /\bspearhead(?:ed|ing)?\b/i },
  { root: "manage", pattern: /\b(?:managed|managing|manages)\b/i },
  { root: "direct", pattern: /\b(?:directed|directing)\b/i },
  { root: "head", pattern: /\bheaded\b/i },
  { root: "found", pattern: /\b(?:founded|co-founded|cofounded)\b/i },
  { root: "oversee", pattern: /\b(?:oversaw|overseeing)\b/i },
];

/**
 * Responsibility verbs that the paragraph uses but the CV lines behind it do not. Returns the claimed
 * verb as written in the paragraph ("led"). Empty when the paragraph claims nothing extra.
 */
export function findScopeClaims(text: string, evidence: readonly string[]): string[] {
  const haystack = evidence.join(" ");
  const claims: string[] = [];
  for (const { pattern } of SCOPE_ROOTS) {
    const used = pattern.exec(text);
    if (used === null) continue;
    if (!pattern.test(haystack)) claims.push(used[0].toLowerCase());
  }
  return claims;
}

/**
 * How much of `text` is copied word for word from `source`: the share of its 4-word runs that also occur
 * in `source`. A condensed paragraph reuses a few phrases (about 0.2 to 0.4); a pasted CV line is near 1.
 */
export function copyRatio(text: string, source: string): number {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((word) => word !== "");
  const runs = (list: string[]) => {
    const result: string[] = [];
    for (let i = 0; i + 4 <= list.length; i += 1) result.push(list.slice(i, i + 4).join(" "));
    return result;
  };
  const mine = runs(words(text));
  if (mine.length === 0) return 0;
  const theirs = new Set(runs(words(source)));
  return mine.filter((run) => theirs.has(run)).length / mine.length;
}

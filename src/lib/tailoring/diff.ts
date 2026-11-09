/**
 * Word-level diff for the "original vs tailored" highlighting in the Review & Edit screen.
 *
 * Pure and dependency-free, so it runs in the browser on every keystroke. The comparison ignores
 * case and surrounding punctuation ("team," equals "team"), so only real wording changes light up.
 */

export type DiffKind = "same" | "added" | "removed";

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

export interface WordDiff {
  /** The original text, with the words that are gone (or changed) marked "removed". */
  before: DiffSegment[];
  /** The new text, with the words that are new (or changed) marked "added". */
  after: DiffSegment[];
}

/** Above this many words per side the quadratic diff is skipped and everything is marked changed. */
const MAX_DIFF_WORDS = 600;

function keyOf(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Words with their trailing whitespace attached, so concatenating the tokens restores the text. */
function toTokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function push(segments: DiffSegment[], kind: DiffKind, text: string): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) last.text += text;
  else segments.push({ kind, text });
}

export function diffWords(before: string, after: string): WordDiff {
  const a = toTokens(before);
  const b = toTokens(after);

  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) {
    return {
      before: before === "" ? [] : [{ kind: "removed", text: before }],
      after: after === "" ? [] : [{ kind: "added", text: after }],
    };
  }

  const keysA = a.map(keyOf);
  const keysB = b.map(keyOf);
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i];
    const below = lcs[i + 1];
    if (!row || !below) continue;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = keysA[i] === keysB[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const resultBefore: DiffSegment[] = [];
  const resultAfter: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const tokenA = a[i] ?? "";
    const tokenB = b[j] ?? "";
    if (keysA[i] === keysB[j]) {
      push(resultBefore, "same", tokenA);
      push(resultAfter, "same", tokenB);
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      push(resultBefore, "removed", tokenA);
      i += 1;
    } else {
      push(resultAfter, "added", tokenB);
      j += 1;
    }
  }
  for (; i < n; i += 1) push(resultBefore, "removed", a[i] ?? "");
  for (; j < m; j += 1) push(resultAfter, "added", b[j] ?? "");

  return { before: resultBefore, after: resultAfter };
}

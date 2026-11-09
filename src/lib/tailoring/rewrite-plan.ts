/**
 * Step 1 -> step 2 of the local pipeline, in plain code (no model involved):
 *
 *  - `planRewrites` turns the model's CV map into the list of texts that are worth a rewrite call:
 *    one per real bullet plus the summary, in CV order. It applies the same filters as buildCvDraft
 *    (a line must exist, must not be a heading or a job header, must not be used twice), so every
 *    rewrite the runner produces has a place in the draft.
 *  - `mergeRewrites` puts the rewrites back into the shape buildCvDraft already understands, so the
 *    guardrails, the score guard and the review UI do not change.
 */
import { buildSourceIndex } from "@/lib/tailoring/guardrails";
import { cleanLine, looksLikeHeader, resolveSummaryOriginal } from "@/lib/tailoring/build-draft";
import { sanitizeInline } from "@/lib/sanitize";
import type { CvLlmOutput, CvStructureOutput } from "@/schemas/tailoring";

/** A one-line cost cap: each call is a few seconds on a laptop CPU, so a CV with 60 bullets is trimmed. */
export const MAX_REWRITE_TARGETS = 30;
/** A bullet this short ("Fluent in English") has nothing to tailor. */
export const MIN_REWRITE_WORDS = 5;

export interface RewriteTarget {
  /** "summary", or "line-<n>" for the CV line the bullet came from. */
  key: string;
  kind: "bullet" | "summary";
  /** The user's own wording, exactly as in the CV. */
  original: string;
  /** "Senior Product Manager at Acme AB" (bullets only), so the model knows what the line is about. */
  role: string;
}

export interface RewritePlan {
  targets: RewriteTarget[];
  /** Bullets and summary that exist but are not sent to the model (too short, or over the cap). */
  skipped: number;
}

function roleLabel(title: string, company: string): string {
  const parts = [sanitizeInline(title).trim(), sanitizeInline(company).trim()].filter((part) => part !== "");
  return parts.length === 2 ? `${parts[0]} at ${parts[1]}` : (parts[0] ?? "");
}

function words(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

export function planRewrites(structure: CvStructureOutput, cvText: string): RewritePlan {
  const source = buildSourceIndex(cvText);
  const targets: RewriteTarget[] = [];
  let skipped = 0;

  const summary = resolveSummaryOriginal(structure.summaryLines, source);
  if (summary !== null) {
    if (words(summary) >= MIN_REWRITE_WORDS) targets.push({ key: "summary", kind: "summary", original: summary, role: "" });
    else skipped += 1;
  }

  const used = new Set<number>();
  for (const entry of structure.experience.slice(0, 20)) {
    const role = roleLabel(entry.title, entry.company);
    for (const value of entry.bullets.slice(0, 20)) {
      if (!Number.isFinite(value)) continue;
      const id = Math.round(value);
      const raw = source.lines[id - 1]?.raw;
      if (raw === undefined || used.has(id) || looksLikeHeader(raw)) continue;
      used.add(id);
      const original = cleanLine(raw, 1_200);
      if (words(original) < MIN_REWRITE_WORDS || targets.length >= MAX_REWRITE_TARGETS) {
        skipped += 1;
        continue;
      }
      targets.push({ key: `line-${id}`, kind: "bullet", original, role });
    }
  }
  return { targets, skipped };
}

/**
 * The step-1 map plus the rewrites, as the CvLlmOutput that buildCvDraft expects. A target without a
 * rewrite gets an empty `tailored`, which buildCvDraft turns into "keep the original wording".
 */
export function mergeRewrites(structure: CvStructureOutput, rewrites: ReadonlyMap<string, string>): CvLlmOutput {
  return {
    fullName: structure.fullName,
    location: structure.location,
    summary: { lines: structure.summaryLines, tailored: rewrites.get("summary") ?? "" },
    experience: structure.experience.map((entry) => ({
      company: entry.company,
      title: entry.title,
      location: entry.location,
      startDate: entry.startDate,
      endDate: entry.endDate,
      bullets: entry.bullets.map((line) => ({
        line,
        tailored: Number.isFinite(line) ? (rewrites.get(`line-${Math.round(line)}`) ?? "") : "",
      })),
    })),
    education: structure.education,
    additional: structure.additional,
    matchedKeywords: structure.matchedKeywords,
    gaps: structure.gaps,
    notes: structure.notes,
  };
}

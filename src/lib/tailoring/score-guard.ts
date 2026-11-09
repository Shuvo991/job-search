/**
 * "Never worse than your CV": every AI rewrite that passed the safety checks is also tried against the
 * app's own offline ATS scorer (src/lib/ats-scorer.ts) on the exact text the PDF will contain. A rewrite
 * that would LOWER the job match (for example by dropping a keyword the posting asks for) is not
 * applied; the user's wording stays and the AI version is one click away.
 *
 * Greedy and deterministic: start from the user's own wording everywhere, then add rewrites one at a
 * time and keep each one only if the score does not go down. The final score is therefore never lower
 * than the score of the original wording. Pure, so it is unit-tested without Ollama.
 */
import { scoreResume } from "@/lib/ats-scorer";
import { cvToPlainText, draftToCvDocument } from "@/lib/tailoring/documents";
import { normalizeForMatch } from "@/lib/tailoring/guardrails";
import type { CvDraft, TextDraft } from "@/lib/tailoring/types";

export interface ScoreGuardResult {
  /** ATS score of the CV with the user's own wording everywhere. */
  baseline: number;
  /** ATS score of the CV as it is now (AI rewrites applied where they help). */
  final: number;
  /** Rewrites that were not applied because they would have lowered the score. */
  heldBack: number;
}

export function applyScoreGuard(draft: CvDraft, jobSkills: readonly string[]): ScoreGuardResult {
  const score = (): number =>
    scoreResume({ resumeText: cvToPlainText(draftToCvDocument(draft)), jobSkills }).overallScore;

  const candidates: TextDraft[] = [draft.summary, ...draft.experience.flatMap((entry) => entry.bullets)].filter(
    (item) =>
      item.flags.length === 0 &&
      item.suggested.trim() !== "" &&
      item.text === item.suggested &&
      normalizeForMatch(item.suggested) !== normalizeForMatch(item.original ?? ""),
  );

  // Start from the user's own wording everywhere.
  for (const item of candidates) item.text = item.original ?? "";
  const baseline = score();
  let current = baseline;
  let heldBack = 0;

  for (const item of candidates) {
    const fallback = item.original ?? "";
    item.text = item.suggested;
    const next = score();
    if (next >= current) {
      current = next;
    } else {
      item.text = fallback;
      item.flags.push(
        `Using it would lower this CV's ATS match for the job (${current} to ${next}), so your wording was kept. Use the AI version only if you prefer it.`,
      );
      heldBack += 1;
    }
  }
  return { baseline, final: current, heldBack };
}

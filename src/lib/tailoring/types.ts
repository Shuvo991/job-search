/**
 * Shapes exchanged between the generation endpoints and the Review & Edit UI.
 * Plain data only (no Date objects, no classes) so they survive JSON.
 */

export interface ContactDraft {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
}

/**
 * One piece of text the user reviews: a bullet, or the summary.
 *
 * - `original`  the CV's own words, snapped to the real CV text. `null` = no original exists
 *               (a summary the CV never had, or a text the user added).
 * - `suggested` what the AI proposed.
 * - `text`      what is currently in the editor (starts as `suggested`, or as `original` when a
 *               guardrail rejected the suggestion). This is what gets exported.
 * - `flags`     guardrail messages, shown next to the text.
 */
export interface TextDraft {
  id: string;
  original: string | null;
  suggested: string;
  text: string;
  flags: string[];
}

export interface ExperienceDraft {
  id: string;
  title: string;
  company: string;
  location: string;
  startDate: string;
  endDate: string;
  /** Fields that could not be matched to the CV and were left blank for the user to fill in. */
  issues: string[];
  bullets: TextDraft[];
}

export interface EducationDraft {
  id: string;
  institution: string;
  degree: string;
  startDate: string;
  endDate: string;
}

export interface AdditionalDraft {
  id: string;
  heading: string;
  items: string[];
}

export interface CvDraft {
  contact: ContactDraft;
  summary: TextDraft;
  skills: string[];
  experience: ExperienceDraft[];
  education: EducationDraft[];
  additional: AdditionalDraft[];
  matchedKeywords: string[];
  gaps: string[];
  notes: string[];
}

export interface GenerationMeta {
  model: string;
  durationMs: number;
  attempts: number;
  /** Which prompt file produced this and its content hash, so a stored document stays traceable. */
  promptFile: string;
  promptHash: string;
}

export interface TailorCvResponse {
  draft: CvDraft;
  warnings: string[];
  meta: GenerationMeta;
}

/**
 * What /api/documents/tailor-cv sends line by line (NDJSON) when the browser asks for progress with
 * `Accept: application/x-ndjson`. The last line is always one "result" or one "error".
 */
export type TailorStreamEvent =
  | { type: "progress"; stage: "reading" | "rewriting"; done: number; total: number; label: string }
  | { type: "result"; result: TailorCvResponse }
  | { type: "error"; error: { code: string; message: string; details?: unknown } };

export interface LetterParagraphDraft {
  id: string;
  text: string;
  /** CV lines (snapped to the real CV text) that back the claims in this paragraph. */
  evidence: string[];
  flags: string[];
}

export interface CoverLetterDraft {
  contact: ContactDraft;
  greeting: string;
  paragraphs: LetterParagraphDraft[];
  closing: string;
  requirementsAddressed: string[];
  gaps: string[];
}

export interface CoverLetterResponse {
  draft: CoverLetterDraft;
  warnings: string[];
  meta: GenerationMeta;
}

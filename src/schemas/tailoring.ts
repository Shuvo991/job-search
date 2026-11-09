import { z } from "zod";
import { MAX_RESUME_CHARS } from "@/lib/resume/text";
import { idSchema, shortText } from "@/schemas/common";

// ---------------------------------------------------------------------------
// 1. What the local model must return.
//
// These schemas are sent to Ollama as a JSON Schema (`format`), so they are intentionally lean:
// plain strings and arrays, no length limits (small models decode more reliably against a simple
// grammar). Every value is checked, sanitised and capped in src/lib/tailoring/build-draft.ts.
// An empty string means "the CV does not say".
// ---------------------------------------------------------------------------

/**
 * The CV is sent to the model with numbered lines ("[12] Led a team of 5..."). The model answers with
 * line NUMBERS instead of copying text back: its output is about half as long (faster on a laptop),
 * and the "original" side of every bullet is exactly the user's own line, never a misquote. Numbers
 * are plain `number` (not `.int()`: that adds huge min/max bounds to the JSON Schema); the server
 * rounds and range-checks them. The skills list is built in code, not by the model.
 */
const bulletLlmSchema = z.object({
  line: z.number(),
  tailored: z.string(),
});

export const cvLlmSchema = z.object({
  fullName: z.string(),
  location: z.string(),
  summary: z.object({ lines: z.array(z.number()), tailored: z.string() }),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      bullets: z.array(bulletLlmSchema),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      startDate: z.string(),
      endDate: z.string(),
    }),
  ),
  additional: z.array(z.object({ heading: z.string(), lines: z.array(z.number()) })),
  matchedKeywords: z.array(z.string()),
  gaps: z.array(z.string()),
  notes: z.array(z.string()),
});

export type CvLlmOutput = z.infer<typeof cvLlmSchema>;

/**
 * Step 1 of the local pipeline: the model only MAPS the CV (which lines are the summary, which jobs
 * exist, which lines belong to which job). It writes no new text, so its answer is short and a 7B model
 * on a laptop CPU finishes it in about a minute. Bullets are plain line numbers.
 */
export const cvStructureSchema = z.object({
  fullName: z.string(),
  location: z.string(),
  summaryLines: z.array(z.number()),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      bullets: z.array(z.number()),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      startDate: z.string(),
      endDate: z.string(),
    }),
  ),
  additional: z.array(z.object({ heading: z.string(), lines: z.array(z.number()) })),
  matchedKeywords: z.array(z.string()),
  gaps: z.array(z.string()),
  notes: z.array(z.string()),
});

export type CvStructureOutput = z.infer<typeof cvStructureSchema>;

/**
 * Step 2: one bullet (or the summary) at a time. A one-field answer is the easiest thing a small model
 * can produce reliably, and a bad answer only costs that one bullet.
 */
export const rewriteLlmSchema = z.object({ rewrite: z.string() });

export type RewriteLlmOutput = z.infer<typeof rewriteLlmSchema>;

export const coverLetterLlmSchema = z.object({
  greeting: z.string(),
  paragraphs: z.array(
    z.object({
      text: z.string(),
      evidence: z.array(z.string()),
      /** Set by the application for paragraphs that make no claim about the CV (template opening, closing). */
      noEvidenceNeeded: z.boolean().optional(),
    }),
  ),
  closing: z.string(),
  requirementsAddressed: z.array(z.string()),
  gaps: z.array(z.string()),
});

export type CoverLetterLlmOutput = z.infer<typeof coverLetterLlmSchema>;

/** The local pipeline writes the letter one paragraph per call (see src/lib/tailoring/letter-runner.ts). */
export const letterParagraphSchema = z.object({ paragraph: z.string() });

export type LetterParagraphOutput = z.infer<typeof letterParagraphSchema>;

/** The one sentence that connects a body paragraph to a need of the role (a separate, tiny call). */
export const letterLinkSchema = z.object({ sentence: z.string() });

export type LetterLinkOutput = z.infer<typeof letterLinkSchema>;

// ---------------------------------------------------------------------------
// 2. Requests to the generation endpoints.
// ---------------------------------------------------------------------------

/** An Ollama model name such as "llama3.2", "qwen2.5:7b" or "library/llama3.2:3b". */
export const modelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Invalid model name");

export const tailorRequestSchema = z.object({
  jobId: idSchema,
  resumeText: z.string().max(MAX_RESUME_CHARS * 2),
  model: modelNameSchema.optional(),
});

export type TailorRequest = z.infer<typeof tailorRequestSchema>;

// ---------------------------------------------------------------------------
// 3. The FINAL documents the user exports (after reviewing and editing).
//    Only plain strings: the PDF renderer never receives markup.
// ---------------------------------------------------------------------------

const line = (max: number) => z.string().trim().max(max);

export const cvDocumentSchema = z.object({
  fullName: shortText(120),
  email: line(320),
  phone: line(60),
  location: line(160),
  links: z.array(shortText(300)).max(6),
  summary: line(1_500),
  skills: z.array(shortText(80)).max(80),
  experience: z
    .array(
      z.object({
        title: line(200),
        company: line(200),
        location: line(160),
        startDate: line(40),
        endDate: line(40),
        bullets: z.array(shortText(700)).max(20),
      }),
    )
    .max(20),
  education: z
    .array(
      z.object({
        institution: line(200),
        degree: line(250),
        startDate: line(40),
        endDate: line(40),
      }),
    )
    .max(12),
  additional: z
    .array(z.object({ heading: shortText(80), items: z.array(shortText(400)).max(30) }))
    .max(8),
});

export type CvDocument = z.infer<typeof cvDocumentSchema>;

export const coverLetterDocumentSchema = z.object({
  senderName: shortText(120),
  email: line(320),
  phone: line(60),
  location: line(160),
  date: line(40),
  company: line(200),
  jobTitle: line(200),
  greeting: shortText(200),
  paragraphs: z.array(shortText(2_500)).min(1).max(8),
  closing: line(300),
  signOff: shortText(60),
});

export type CoverLetterDocument = z.infer<typeof coverLetterDocumentSchema>;

export const pdfRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cv"), document: cvDocumentSchema }),
  z.object({ kind: z.literal("cover-letter"), document: coverLetterDocumentSchema }),
]);

export type PdfRequest = z.infer<typeof pdfRequestSchema>;

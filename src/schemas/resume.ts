import { z } from "zod";

/** Hard ceiling for a resume upload; `MAX_UPLOAD_BYTES` in .env may only lower it. */
export const RESUME_MAX_BYTES = 5 * 1024 * 1024;

/** The multipart form: exactly one file in the field named `file`. */
export const resumeUploadSchema = z.object({
  file: z.instanceof(File, { message: "A resume file is required in the 'file' field" }),
});

export type ResumeFileType = "pdf" | "docx";

/** Response body of POST /api/resume/parse. */
export interface ParsedResumeResponse {
  fileName: string;
  fileType: ResumeFileType;
  /** The verified (byte-sniffed) MIME type, not the one the client claimed. */
  mimeType: string;
  sizeBytes: number;
  /** Total pages for PDFs; null for DOCX (pages are not known without rendering). */
  pageCount: number | null;
  wordCount: number;
  /** True when the document had more pages than were read, or the text hit the length cap. */
  truncated: boolean;
  /** Normalised plain text, ready for the ATS scorer. Render it as text only, never as HTML. */
  text: string;
}

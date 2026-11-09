import { extractContact } from "@/lib/tailoring/contact";
import type { CoverLetterDraft, CvDraft } from "@/lib/tailoring/types";

/**
 * Empty drafts for the "write it myself" path, used when Ollama is not available. The only thing
 * filled in is the contact block, read from the CV text with regular expressions (no AI).
 */
export function blankCvDraft(resumeText: string): CvDraft {
  return {
    contact: extractContact(resumeText),
    summary: { id: "summary", original: null, suggested: "", text: "", flags: [] },
    skills: [],
    experience: [],
    education: [],
    additional: [],
    matchedKeywords: [],
    gaps: [],
    notes: [],
  };
}

export function blankCoverLetterDraft(resumeText: string): CoverLetterDraft {
  return {
    contact: extractContact(resumeText),
    greeting: "Dear Hiring Team,",
    paragraphs: [{ id: "para-0", text: "", evidence: [], flags: [] }],
    closing: "Thank you for your time and consideration.",
    requirementsAddressed: [],
    gaps: [],
  };
}

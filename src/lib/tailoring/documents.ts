/**
 * From the drafts being edited on screen to the FINAL documents that are exported.
 *
 * `draftTo...Document` flattens what the user sees (after their edits) into plain strings,
 * dropping empty items. `...ToPlainText` renders the same document as the text a machine will read
 * from the PDF, using the same headings and order as the PDF, so the on-screen ATS score is computed
 * on exactly what an applicant tracking system will extract.
 *
 * Pure and free of Node-only imports: the Review & Edit screen runs it in the browser.
 */
import type { ContactDraft, CvDraft } from "@/lib/tailoring/types";
import type { CoverLetterDocument, CvDocument } from "@/schemas/tailoring";

/** Standard section names: they match the aliases in config/ats-rules.json. */
export const CV_SECTION_TITLES = {
  summary: "PROFESSIONAL SUMMARY",
  skills: "SKILLS",
  experience: "WORK EXPERIENCE",
  education: "EDUCATION",
} as const;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

export function draftToCvDocument(draft: CvDraft): CvDocument {
  const { contact } = draft;
  return {
    fullName: collapse(contact.fullName),
    email: collapse(contact.email),
    phone: collapse(contact.phone),
    location: collapse(contact.location),
    links: contact.links.map(collapse).filter((link) => link !== ""),
    summary: collapse(draft.summary.text),
    skills: draft.skills.map(collapse).filter((skill) => skill !== ""),
    experience: draft.experience
      .map((entry) => ({
        title: collapse(entry.title),
        company: collapse(entry.company),
        location: collapse(entry.location),
        startDate: collapse(entry.startDate),
        endDate: collapse(entry.endDate),
        bullets: entry.bullets.map((bullet) => collapse(bullet.text)).filter((text) => text !== ""),
      }))
      .filter((entry) => entry.title !== "" || entry.company !== "" || entry.bullets.length > 0),
    education: draft.education
      .map((entry) => ({
        institution: collapse(entry.institution),
        degree: collapse(entry.degree),
        startDate: collapse(entry.startDate),
        endDate: collapse(entry.endDate),
      }))
      .filter((entry) => entry.institution !== "" || entry.degree !== ""),
    additional: draft.additional
      .map((section) => ({
        heading: collapse(section.heading),
        items: section.items.map(collapse).filter((item) => item !== ""),
      }))
      .filter((section) => section.heading !== "" && section.items.length > 0),
  };
}

export interface CoverLetterFormState {
  contact: ContactDraft;
  date: string;
  greeting: string;
  paragraphs: string[];
  closing: string;
  signOff: string;
}

export function draftToCoverLetterDocument(
  state: CoverLetterFormState,
  job: { title: string; company: string },
): CoverLetterDocument {
  return {
    senderName: collapse(state.contact.fullName),
    email: collapse(state.contact.email),
    phone: collapse(state.contact.phone),
    location: collapse(state.contact.location),
    date: collapse(state.date),
    company: collapse(job.company),
    jobTitle: collapse(job.title),
    greeting: collapse(state.greeting),
    paragraphs: state.paragraphs.map(collapse).filter((paragraph) => paragraph !== ""),
    closing: collapse(state.closing),
    signOff: collapse(state.signOff),
  };
}

// ---------------------------------------------------------------------------
// Shared line formats (used by the PDF and by the plain-text rendering)
// ---------------------------------------------------------------------------

const join = (parts: readonly string[], separator: string): string =>
  parts.filter((part) => part !== "").join(separator);

export function contactLine(doc: Pick<CvDocument, "email" | "phone" | "location" | "links">): string {
  return join([doc.location, doc.phone, doc.email, ...doc.links], " | ");
}

export function dateRange(startDate: string, endDate: string): string {
  return join([startDate, endDate], " - ");
}

/** "Company, Location | Jan 2020 - Present" (the title is printed on its own line above). */
export function experienceDetailLine(entry: CvDocument["experience"][number]): string {
  return join([join([entry.company, entry.location], ", "), dateRange(entry.startDate, entry.endDate)], " | ");
}

/** "Institution | Degree | 2019 - 2021" */
export function educationLine(entry: CvDocument["education"][number]): string {
  return join([entry.institution, entry.degree, dateRange(entry.startDate, entry.endDate)], " | ");
}

export function cvToPlainText(doc: CvDocument): string {
  const lines: string[] = [doc.fullName, contactLine(doc)];

  if (doc.summary !== "") lines.push("", CV_SECTION_TITLES.summary, doc.summary);
  if (doc.skills.length > 0) lines.push("", CV_SECTION_TITLES.skills, doc.skills.join(", "));

  if (doc.experience.length > 0) {
    lines.push("", CV_SECTION_TITLES.experience);
    for (const entry of doc.experience) {
      if (entry.title !== "") lines.push(entry.title);
      const detail = experienceDetailLine(entry);
      if (detail !== "") lines.push(detail);
      for (const bullet of entry.bullets) lines.push(`• ${bullet}`);
      lines.push("");
    }
  }

  if (doc.education.length > 0) {
    lines.push(CV_SECTION_TITLES.education);
    for (const entry of doc.education) lines.push(educationLine(entry));
  }

  for (const section of doc.additional) {
    lines.push("", section.heading.toUpperCase());
    for (const item of section.items) lines.push(item);
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function coverLetterToPlainText(doc: CoverLetterDocument): string {
  return [
    doc.senderName,
    join([doc.location, doc.phone, doc.email], " | "),
    "",
    doc.date,
    "",
    doc.company,
    doc.jobTitle !== "" ? `Re: ${doc.jobTitle}` : "",
    "",
    doc.greeting,
    "",
    doc.paragraphs.join("\n\n"),
    "",
    doc.closing,
    "",
    doc.signOff,
    doc.senderName,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Renders a real PDF with @react-pdf/renderer and reads it back with the same pdf-parse code that
 * parses uploaded resumes. This is the machine-readability check: what an ATS would extract.
 * Requires: npm install @react-pdf/renderer
 */
import { describe, expect, it } from "vitest";
import { scoreResume } from "@/lib/ats-scorer";
import { renderCoverLetterPdf, renderCvPdf } from "@/lib/pdf/render";
import { extractResumeText } from "@/lib/resume/extract-text";
import { normalizeResumeText } from "@/lib/resume/text";
import { cvToPlainText } from "@/lib/tailoring/documents";
import type { CvDocument } from "@/schemas/tailoring";

const SLOW = 60_000;

const LONG_BULLET =
  "Orchestrated multidisciplinary internationalization and accessibility improvements across several product teams, " +
  "coordinating prioritisation, documentation and stakeholder communication throughout the entire programme";

const cv: CvDocument = {
  fullName: "Åsa Öberg",
  email: "asa.oberg@example.com",
  phone: "+46 70 123 45 67",
  location: "Stockholm",
  links: ["linkedin.com/in/asaoberg"],
  summary: "Product manager with a record of shipping payments features.",
  skills: ["Roadmapping", "Jira", "SQL", "Stakeholder management"],
  experience: [
    {
      title: "Senior Product Manager",
      company: "Acme AB",
      location: "Stockholm",
      startDate: "Jan 2021",
      endDate: "Present",
      bullets: [LONG_BULLET, "Led a team of 5 engineers to ship a payments feature used by 40% of customers"],
    },
  ],
  education: [
    { institution: "Stockholm University", degree: "MSc Computer Science", startDate: "2017", endDate: "2019" },
  ],
  additional: [{ heading: "Languages", items: ["English (fluent)", "Swedish (native)"] }],
};

async function extract(pdf: Buffer) {
  return extractResumeText(new Uint8Array(pdf), "pdf");
}

describe("renderCvPdf", () => {
  it("produces a one-page PDF whose text layer is the whole CV in reading order", async () => {
    const pdf = await renderCvPdf(cv);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    const result = await extract(pdf);
    expect(result.pageCount).toBe(1);
    const text = normalizeResumeText(result.text);

    for (const heading of ["PROFESSIONAL SUMMARY", "SKILLS", "WORK EXPERIENCE", "EDUCATION", "LANGUAGES"]) {
      expect(text).toContain(heading);
    }
    expect(text.indexOf("PROFESSIONAL SUMMARY")).toBeLessThan(text.indexOf("SKILLS"));
    expect(text.indexOf("SKILLS")).toBeLessThan(text.indexOf("WORK EXPERIENCE"));
    expect(text.indexOf("WORK EXPERIENCE")).toBeLessThan(text.indexOf("EDUCATION"));
    expect(text).toContain("asa.oberg@example.com");
    expect(text).toContain("Senior Product Manager");
    expect(text).toContain("Acme AB, Stockholm | Jan 2021 - Present");
  }, SLOW);

  it("never hyphenates: every word of a long wrapped bullet survives extraction", async () => {
    const text = (await extract(await renderCvPdf(cv))).text;
    const extractedWords = new Set(text.split(/\s+/));
    for (const word of LONG_BULLET.split(" ")) expect(extractedWords.has(word)).toBe(true);
  }, SLOW);

  it("keeps Nordic letters", async () => {
    const text = (await extract(await renderCvPdf(cv))).text;
    expect(text).toContain("Åsa Öberg");
  }, SLOW);

  it("is recognised by the ATS scorer: required sections found", async () => {
    const text = normalizeResumeText((await extract(await renderCvPdf(cv))).text);
    const report = scoreResume({ resumeText: text, jobSkills: ["Roadmapping", "Jira"], pageCount: 1 });
    expect(report.sections.missingRequired).toEqual([]);
    expect(report.keywords.missing).toEqual([]);
  }, SLOW);

  it("plain-text rendering used for the live score uses the same headings", () => {
    const text = cvToPlainText(cv);
    expect(text).toContain("WORK EXPERIENCE");
    expect(text).toContain("• Led a team of 5 engineers");
  });
});

describe("renderCoverLetterPdf", () => {
  it("renders a one-page letter with the sender, the recipient and every paragraph", async () => {
    const pdf = await renderCoverLetterPdf({
      senderName: "Jane Doe",
      email: "jane@example.com",
      phone: "",
      location: "Stockholm",
      date: "8 November 2026",
      company: "Globex",
      jobTitle: "Product Lead",
      greeting: "Dear Hiring Team,",
      paragraphs: ["First paragraph about payments.", "Second paragraph about discovery."],
      closing: "Thank you for your time.",
      signOff: "Sincerely,",
    });
    const result = await extract(pdf);
    expect(result.pageCount).toBe(1);
    for (const expected of ["Jane Doe", "Re: Product Lead", "Dear Hiring Team,", "Second paragraph about discovery.", "Sincerely,"]) {
      expect(result.text).toContain(expected);
    }
  }, SLOW);
});

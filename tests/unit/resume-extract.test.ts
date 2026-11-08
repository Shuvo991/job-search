/**
 * Runs the REAL pdf-parse and mammoth libraries on tiny files built in memory by
 * tests/helpers/resume-files.ts. Everything else mocks them; this file is what proves the
 * libraries are called correctly. Requires: npm install pdf-parse mammoth
 */
import { describe, expect, it } from "vitest";
import { UnprocessableEntityError } from "@/lib/errors";
import { extractResumeText, MAX_PDF_PAGES } from "@/lib/resume/extract-text";
import { buildDocx, buildPdf, buildZip } from "../helpers/resume-files";

const SLOW = 30_000; // the first PDF.js load can take a few seconds

async function rejection(run: () => Promise<unknown>): Promise<UnprocessableEntityError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UnprocessableEntityError) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

describe("extractResumeText: PDF (pdf-parse)", () => {
  it("extracts the text and page count of a text PDF", async () => {
    const result = await extractResumeText(buildPdf([["Jane Doe", "Led a team of 5 engineers (really)"]]), "pdf");
    expect(result.kind).toBe("pdf");
    expect(result.text).toContain("Jane Doe");
    expect(result.text).toContain("Led a team of 5 engineers (really)");
    expect(result.pageCount).toBe(1);
    expect(result.truncated).toBe(false);
  }, SLOW);

  it("returns empty text, not an error, for a PDF with a blank page", async () => {
    const result = await extractResumeText(buildPdf([[]]), "pdf");
    expect(result.text.trim()).toBe("");
    expect(result.pageCount).toBe(1);
  }, SLOW);

  it("joins pages without page-number markers", async () => {
    const result = await extractResumeText(buildPdf([["First page text"], ["Second page text"]]), "pdf");
    expect(result.pageCount).toBe(2);
    expect(result.text).toContain("First page text");
    expect(result.text).toContain("Second page text");
    expect(result.text).not.toMatch(/-- \d+ of \d+ --/);
  }, SLOW);

  it(`reads only the first ${MAX_PDF_PAGES} pages but reports the real page count`, async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 2 }, (_, i) => [`marker${i + 1}end`]);
    const result = await extractResumeText(buildPdf(pages), "pdf");
    expect(result.pageCount).toBe(MAX_PDF_PAGES + 2);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("marker1end");
    expect(result.text).toContain(`marker${MAX_PDF_PAGES}end`);
    expect(result.text).not.toContain(`marker${MAX_PDF_PAGES + 1}end`);
  }, SLOW);

  it("leaves the caller's buffer intact (PDF.js gets a private copy)", async () => {
    const bytes = buildPdf([["Hello there"]]);
    const original = Uint8Array.from(bytes);
    await extractResumeText(bytes, "pdf");
    expect(bytes.byteLength).toBe(original.byteLength);
    expect(Buffer.compare(bytes, original)).toBe(0);
  }, SLOW);

  it("turns a damaged PDF into a 422", async () => {
    const damaged = new TextEncoder().encode("%PDF-1.4\nthis is definitely not a pdf document\n%%EOF");
    const error = await rejection(() => extractResumeText(damaged, "pdf"));
    expect(error.status).toBe(422);
    expect(error.message).toContain("could not be read");
  }, SLOW);
});

describe("extractResumeText: DOCX (mammoth)", () => {
  it("extracts paragraphs as lines and decodes XML entities", async () => {
    const result = await extractResumeText(
      buildDocx(["Jane Doe", "EXPERIENCE", "Led a team of 5 engineers & built <things>"]),
      "docx",
    );
    expect(result.kind).toBe("docx");
    expect(result.text.split("\n").filter((line) => line !== "")).toEqual([
      "Jane Doe",
      "EXPERIENCE",
      "Led a team of 5 engineers & built <things>",
    ]);
    expect(result.text).not.toContain("\n\n");
    expect(result.pageCount).toBeUndefined();
    expect(result.truncated).toBe(false);
  }, SLOW);

  it("returns empty text for a document without paragraphs", async () => {
    const result = await extractResumeText(buildDocx([]), "docx");
    expect(result.text.trim()).toBe("");
  }, SLOW);

  it("turns a ZIP that is not a Word document into a 422", async () => {
    const notWord = buildZip([{ name: "readme.txt", data: "hello" }]);
    const error = await rejection(() => extractResumeText(notWord, "docx"));
    expect(error.status).toBe(422);
  }, SLOW);
});

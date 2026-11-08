/**
 * POST /api/resume/parse with the REAL pdf-parse and mammoth (nothing mocked), the closest
 * automated equivalent of uploading a file in the browser. Requires: npm install pdf-parse mammoth
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/resume/parse/route";
import { resetEnvCache } from "@/lib/env";
import { buildDocx, buildPdf, toFile, uploadRequest } from "../helpers/resume-files";

const ctx = { params: Promise.resolve({}) };
const SLOW = 30_000;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface ParseBody {
  fileType: string;
  pageCount: number | null;
  wordCount: number;
  text: string;
  error?: { code: string; details?: unknown };
}

async function upload(file: File): Promise<{ status: number; body: ParseBody }> {
  const res = await POST(uploadRequest({ file }), ctx);
  return { status: res.status, body: (await res.json()) as ParseBody };
}

describe("POST /api/resume/parse (real parsers)", () => {
  beforeEach(() => {
    resetEnvCache();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a text PDF", async () => {
    const pdf = buildPdf([["Jane Doe", "Experience", "- Led a team of 5 engineers"]]);
    const { status, body } = await upload(toFile(pdf, "cv.pdf", "application/pdf"));
    expect(status).toBe(200);
    expect(body.fileType).toBe("pdf");
    expect(body.pageCount).toBe(1);
    expect(body.text).toContain("Jane Doe");
    expect(body.text).toContain("Led a team of 5 engineers");
    expect(body.wordCount).toBeGreaterThanOrEqual(8);
  }, SLOW);

  it("parses a DOCX", async () => {
    const docx = buildDocx(["Jane Doe", "Experience", "Led a team of 5 engineers"]);
    const { status, body } = await upload(toFile(docx, "cv.docx", DOCX_MIME));
    expect(status).toBe(200);
    expect(body.fileType).toBe("docx");
    expect(body.pageCount).toBeNull();
    expect(body.text).toBe("Jane Doe\nExperience\nLed a team of 5 engineers");
  }, SLOW);

  it("answers 422 for a PDF with no text", async () => {
    const { status, body } = await upload(toFile(buildPdf([[]]), "blank.pdf", "application/pdf"));
    expect(status).toBe(422);
    expect(body.error?.code).toBe("UNPROCESSABLE_ENTITY");
    expect(body.error?.details).toEqual({ reason: "no_text" });
  }, SLOW);

  it("answers 422 for a damaged PDF", async () => {
    const damaged = new TextEncoder().encode("%PDF-1.4\nnot really a pdf\n%%EOF");
    const { status } = await upload(toFile(damaged, "broken.pdf", "application/pdf"));
    expect(status).toBe(422);
  }, SLOW);
});

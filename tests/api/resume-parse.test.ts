import { readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnprocessableEntityError } from "@/lib/errors";
import { resetEnvCache } from "@/lib/env";
import { RESUME_MAX_BYTES } from "@/schemas/resume";
import { buildDocx, buildPdf, buildZip, toFile, uploadRequest } from "../helpers/resume-files";

// Text extraction is covered by tests/unit/resume-extract.test.ts; here it is replaced so these
// tests exercise only the endpoint: upload handling, verification, response shape and cleanup.
const { extractResumeText } = vi.hoisted(() => ({ extractResumeText: vi.fn() }));
vi.mock("@/lib/resume/extract-text", () => ({ extractResumeText }));

// Keep a handle on every upload the route read, to check that its buffer is wiped afterwards.
const seen = vi.hoisted(() => ({ uploads: [] as Array<{ bytes: Uint8Array }> }));
vi.mock("@/lib/resume/read-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resume/read-upload")>();
  return {
    ...actual,
    readResumeUpload: async (...args: Parameters<typeof actual.readResumeUpload>) => {
      const upload = await actual.readResumeUpload(...args);
      seen.uploads.push(upload);
      return upload;
    },
  };
});

import { POST } from "@/app/api/resume/parse/route";

const ctx = { params: Promise.resolve({}) };
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF = buildPdf([["Hello"]]);
const uploadsDir = path.join(process.cwd(), "uploads");

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

function post(file: File | undefined, extra: Record<string, string> = {}) {
  return POST(uploadRequest({ ...(file ? { file } : {}), ...extra }), ctx);
}

function pdfExtraction(text = "Jane Doe\nExperience\n- Led a team of 5 engineers") {
  return { kind: "pdf", text, pageCount: 1, truncated: false };
}

describe("POST /api/resume/parse", () => {
  beforeEach(() => {
    seen.uploads.length = 0;
    resetEnvCache();
    extractResumeText.mockResolvedValue(pdfExtraction());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    extractResumeText.mockReset();
    vi.unstubAllEnvs();
    resetEnvCache();
    vi.restoreAllMocks();
  });

  describe("success", () => {
    it("returns the parsed text and metadata for a PDF", async () => {
      const res = await post(toFile(PDF, "cv.pdf", PDF_MIME));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-request-id")).toBeTruthy();
      expect(await res.json()).toEqual({
        fileName: "cv.pdf",
        fileType: "pdf",
        mimeType: PDF_MIME,
        sizeBytes: PDF.length,
        pageCount: 1,
        wordCount: 10,
        truncated: false,
        text: "Jane Doe\nExperience\n- Led a team of 5 engineers",
      });
    });

    it("returns pageCount null for a DOCX and reports the verified MIME type", async () => {
      extractResumeText.mockResolvedValue({ kind: "docx", text: "Jane Doe\nSkills", pageCount: undefined, truncated: false });
      const res = await post(toFile(buildDocx(["Jane Doe"]), "cv.docx", DOCX_MIME));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ fileType: "docx", mimeType: DOCX_MIME, pageCount: null, wordCount: 3 });
    });

    it("accepts a missing or generic client MIME type when the bytes are a PDF", async () => {
      for (const type of ["", "application/octet-stream"]) {
        const res = await post(toFile(PDF, "cv.pdf", type));
        expect(res.status, type).toBe(200);
      }
    });

    it("hands the extractor the verified file type and the real bytes", async () => {
      let header = "";
      extractResumeText.mockImplementation(async (bytes: Uint8Array, kind: string) => {
        header = `${kind}:${new TextDecoder().decode(bytes.slice(0, 8))}`;
        return pdfExtraction();
      });
      await post(toFile(PDF, "cv.pdf", PDF_MIME));
      expect(header).toBe("pdf:%PDF-1.4");
    });

    it("normalises the extracted text and reports truncation", async () => {
      extractResumeText.mockResolvedValue({
        kind: "pdf",
        text: "Jane\u0000 \u202EDoe\r\n\r\n\r\n\r\nSkills\u200B",
        pageCount: 12,
        truncated: true,
      });
      const body = (await (await post(toFile(PDF, "cv.pdf", PDF_MIME))).json()) as { text: string; truncated: boolean; pageCount: number };
      expect(body.text).toBe("Jane Doe\n\nSkills");
      expect(body.truncated).toBe(true);
      expect(body.pageCount).toBe(12);
    });
  });

  describe("verification", () => {
    it("rejects a request that is not multipart with 415", async () => {
      const req = new NextRequest("http://localhost/api/resume/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const res = await POST(req, ctx);
      expect(res.status).toBe(415);
    });

    it("rejects a request without a file with 400", async () => {
      const res = await post(undefined, { note: "hi" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an image renamed to .pdf, whatever MIME type it claims", async () => {
      const png = new Uint8Array(64);
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const res = await post(toFile(png, "cv.pdf", PDF_MIME));
      expect(res.status).toBe(415);
      expect(extractResumeText).not.toHaveBeenCalled();
    });

    it("rejects plain text and HTML sent as a PDF", async () => {
      const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
      expect((await post(toFile(html, "cv.pdf", PDF_MIME))).status).toBe(415);
    });

    it("rejects an xlsx renamed to .docx and a macro-enabled document", async () => {
      const xlsx = buildZip([
        { name: "[Content_Types].xml", data: "x" },
        { name: "xl/workbook.xml", data: "x" },
      ]);
      expect((await post(toFile(xlsx, "cv.docx", DOCX_MIME))).status).toBe(415);
      const macro = buildDocx(["x"], [{ name: "word/vbaProject.bin", data: "x" }]);
      expect((await post(toFile(macro, "cv.docx", DOCX_MIME))).status).toBe(415);
      expect(extractResumeText).not.toHaveBeenCalled();
    });

    it("rejects claims that contradict the bytes (MIME type or extension)", async () => {
      expect((await post(toFile(PDF, "cv.pdf", DOCX_MIME))).status).toBe(415);
      expect((await post(toFile(PDF, "cv.docx", PDF_MIME))).status).toBe(415);
      expect((await post(toFile(PDF, "cv.exe", PDF_MIME))).status).toBe(415);
      expect((await post(toFile(buildDocx(["x"]), "cv.pdf", DOCX_MIME))).status).toBe(415);
    });

    it("rejects legacy .doc files with a helpful message", async () => {
      const ole = new Uint8Array(512);
      ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      const res = await post(toFile(ole, "cv.doc", "application/msword"));
      expect(res.status).toBe(415);
      expect(((await res.json()) as ErrorBody).error.message).toContain(".doc");
    });
  });

  describe("size limit", () => {
    function pdfOfSize(size: number): Uint8Array {
      const bytes = new Uint8Array(size);
      bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
      return bytes;
    }

    it("accepts a file of exactly 5 MB and rejects one byte more with 413", async () => {
      expect((await post(toFile(pdfOfSize(RESUME_MAX_BYTES), "cv.pdf", PDF_MIME))).status).toBe(200);
      const res = await post(toFile(pdfOfSize(RESUME_MAX_BYTES + 1), "cv.pdf", PDF_MIME));
      expect(res.status).toBe(413);
      expect(((await res.json()) as ErrorBody).error.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("rejects a body far beyond the limit with 413 without parsing it", async () => {
      const res = await post(toFile(pdfOfSize(RESUME_MAX_BYTES * 2), "cv.pdf", PDF_MIME));
      expect(res.status).toBe(413);
      expect(extractResumeText).not.toHaveBeenCalled();
    });

    it("lets MAX_UPLOAD_BYTES lower the limit, but never raise it above 5 MB", async () => {
      vi.stubEnv("MAX_UPLOAD_BYTES", "2048");
      resetEnvCache();
      expect((await post(toFile(pdfOfSize(3_000), "cv.pdf", PDF_MIME))).status).toBe(413);
      expect((await post(toFile(pdfOfSize(1_500), "cv.pdf", PDF_MIME))).status).toBe(200);

      vi.stubEnv("MAX_UPLOAD_BYTES", String(20 * 1024 * 1024));
      resetEnvCache();
      expect((await post(toFile(pdfOfSize(RESUME_MAX_BYTES + 1), "cv.pdf", PDF_MIME))).status).toBe(413);
    });

    it("rejects an empty file with 400", async () => {
      expect((await post(toFile(new Uint8Array(), "cv.pdf", PDF_MIME))).status).toBe(400);
    });
  });

  describe("unreadable documents", () => {
    it("returns 422 when the file has no selectable text (for example a blank or scanned PDF)", async () => {
      extractResumeText.mockResolvedValue(pdfExtraction("  \n \n\t "));
      const res = await post(toFile(PDF, "cv.pdf", PDF_MIME));
      expect(res.status).toBe(422);
      const { error } = (await res.json()) as ErrorBody;
      expect(error.code).toBe("UNPROCESSABLE_ENTITY");
      expect(error.details).toEqual({ reason: "no_text" });
      expect(error.message).toContain("No selectable text");
    });

    it("passes the extractor's 422 message through (password-protected, damaged)", async () => {
      extractResumeText.mockRejectedValue(new UnprocessableEntityError("The PDF is password-protected"));
      const res = await post(toFile(PDF, "cv.pdf", PDF_MIME));
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorBody).error.message).toBe("The PDF is password-protected");
    });

    it("hides the details of an unexpected extractor failure", async () => {
      extractResumeText.mockRejectedValue(new Error("ENOENT /srv/secret/path/pdf.worker.mjs"));
      const res = await post(toFile(PDF, "cv.pdf", PDF_MIME));
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain("secret");
      expect(JSON.parse(text)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    });
  });

  describe("cleanup", () => {
    it("zero-fills the uploaded bytes after a successful parse", async () => {
      const res = await post(toFile(PDF, "cv.pdf", PDF_MIME));
      expect(res.status).toBe(200);
      expect(seen.uploads).toHaveLength(1);
      expect(seen.uploads[0]?.bytes.length).toBe(PDF.length);
      expect(seen.uploads[0]?.bytes.every((byte) => byte === 0)).toBe(true);
    });

    it("zero-fills the uploaded bytes when verification or extraction fails", async () => {
      const png = new Uint8Array(64).fill(7);
      png.set([0x89, 0x50, 0x4e, 0x47]);
      expect((await post(toFile(png, "cv.pdf", PDF_MIME))).status).toBe(415);

      extractResumeText.mockRejectedValue(new Error("boom"));
      expect((await post(toFile(PDF, "cv.pdf", PDF_MIME))).status).toBe(500);

      extractResumeText.mockResolvedValue(pdfExtraction(""));
      expect((await post(toFile(PDF, "cv.pdf", PDF_MIME))).status).toBe(422);

      expect(seen.uploads).toHaveLength(3);
      for (const upload of seen.uploads) expect(upload.bytes.every((byte) => byte === 0)).toBe(true);
    });

    it("never writes the upload to the uploads directory", async () => {
      const before = readdirSync(uploadsDir).sort();
      await post(toFile(PDF, "cv.pdf", PDF_MIME));
      await post(toFile(new Uint8Array(64), "cv.pdf", PDF_MIME));
      expect(readdirSync(uploadsDir).sort()).toEqual(before);
    });

    it("does not echo a hostile file name unsanitised", async () => {
      const res = await post(toFile(PDF, "../../<script>alert(1)</script>cv.pdf", PDF_MIME));
      const body = (await res.json()) as { fileName: string };
      expect(res.status).toBe(200);
      expect(body.fileName).toBe("cv.pdf");
      expect(body.fileName).not.toContain("<");
      expect(body.fileName).not.toContain("..");
      expect(body.fileName).not.toContain("/");
    });
  });
});

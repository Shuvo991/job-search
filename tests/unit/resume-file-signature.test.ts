import { describe, expect, it } from "vitest";
import { AppError, BadRequestError, UnsupportedMediaTypeError } from "@/lib/errors";
import {
  assertClaimsMatchBytes,
  detectResumeFileKind,
  fileExtension,
  readZipEntries,
  RESUME_MIME_TYPES,
  ZIP_LIMITS,
} from "@/lib/resume/file-signature";
import { buildDocx, buildPdf, buildZip, docxParts } from "../helpers/resume-files";

function failure(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to throw an AppError");
}

const bytesOf = (...values: number[]): Uint8Array => new Uint8Array(values);

describe("detectResumeFileKind: accepted files", () => {
  it("accepts a PDF by its %PDF- header", () => {
    expect(detectResumeFileKind(buildPdf([["Hello"]]))).toBe("pdf");
  });

  it("accepts a real DOCX (ZIP with the Word parts)", () => {
    expect(detectResumeFileKind(buildDocx(["Hello"]))).toBe("docx");
  });

  it("accepts a DOCX whose ZIP has a trailing comment", () => {
    expect(detectResumeFileKind(buildZip(docxParts(["Hello"]), "made by a tool"))).toBe("docx");
  });

  it("lists the parts of a DOCX from its central directory", () => {
    expect(readZipEntries(buildDocx(["Hello"])).map((entry) => entry.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ]);
  });
});

describe("detectResumeFileKind: rejected files", () => {
  it("rejects an empty file with 400", () => {
    const error = failure(() => detectResumeFileKind(new Uint8Array()));
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error.status).toBe(400);
  });

  it("rejects text, images and other formats with 415", () => {
    const samples: Uint8Array[] = [
      new TextEncoder().encode("hello world, this is a plain text resume"),
      bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0),
      bytesOf(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46),
      new TextEncoder().encode("<html><body>resume</body></html>"),
      new TextEncoder().encode("MZ\u0090\u0000\u0003\u0000\u0000\u0000"),
    ];
    for (const sample of samples) {
      const error = failure(() => detectResumeFileKind(sample));
      expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
      expect(error.status).toBe(415);
    }
  });

  it("requires the PDF header at byte 0 and a version", () => {
    const pdf = buildPdf([["Hello"]]);
    const withJunk = new Uint8Array(pdf.length + 1);
    withJunk[0] = 0x0a;
    withJunk.set(pdf, 1);
    expect(failure(() => detectResumeFileKind(withJunk)).status).toBe(415);
    expect(failure(() => detectResumeFileKind(new TextEncoder().encode("%PDF-x.y\n"))).status).toBe(415);
    expect(failure(() => detectResumeFileKind(new TextEncoder().encode("%PDF"))).status).toBe(415);
  });

  it("rejects legacy .doc (OLE2) with a helpful message", () => {
    const ole = new Uint8Array(512);
    ole.set(bytesOf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1));
    const error = failure(() => detectResumeFileKind(ole));
    expect(error.status).toBe(415);
    expect(error.message).toContain(".doc");
  });

  it("rejects ZIPs that are not Word documents (xlsx, pptx, plain archives)", () => {
    const xlsx = buildZip([
      { name: "[Content_Types].xml", data: "x" },
      { name: "xl/workbook.xml", data: "x" },
    ]);
    const archive = buildZip([{ name: "resume.txt", data: "hello" }]);
    for (const file of [xlsx, archive]) {
      const error = failure(() => detectResumeFileKind(file));
      expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
      expect(error.message).toContain("Word");
    }
  });

  it("rejects macro-enabled documents", () => {
    const error = failure(() => detectResumeFileKind(buildDocx(["x"], [{ name: "word/vbaProject.bin", data: "x" }])));
    expect(error.status).toBe(415);
    expect(error.message).toContain("Macro");
  });

  it("rejects encrypted entries", () => {
    const encrypted = buildZip([
      { name: "[Content_Types].xml", data: "x" },
      { name: "word/document.xml", data: "x", flags: 1 },
    ]);
    const error = failure(() => detectResumeFileKind(encrypted));
    expect(error.status).toBe(415);
    expect(error.message).toContain("Encrypted");
  });

  it("rejects a zip bomb from its declared sizes, before anything is unpacked", () => {
    const [types, rels, document] = docxParts(["x"]);
    if (!types || !rels || !document) throw new Error("fixture");

    const oneHuge = buildZip([types, rels, { ...document, declaredUncompressedSize: ZIP_LIMITS.maxEntryUncompressedBytes + 1 }]);
    expect(failure(() => detectResumeFileKind(oneHuge)).status).toBe(400);

    const manyLarge = buildZip([
      types,
      rels,
      document,
      ...Array.from({ length: 4 }, (_, i) => ({
        name: `word/media/big${i}.bin`,
        data: "x",
        declaredUncompressedSize: 20 * 1024 * 1024,
      })),
    ]);
    const error = failure(() => detectResumeFileKind(manyLarge));
    expect(error.status).toBe(400);
    expect(error.message).toContain("too large");
  });

  it("rejects archives with path-traversal part names", () => {
    const evil = buildDocx(["x"], [{ name: "../evil.xml", data: "x" }]);
    expect(failure(() => detectResumeFileKind(evil)).status).toBe(415);
  });

  it("rejects truncated and corrupt ZIPs", () => {
    const docx = buildDocx(["Hello"]);
    expect(failure(() => detectResumeFileKind(docx.slice(0, docx.length - 10))).status).toBe(415);

    const garbage = new Uint8Array(200);
    garbage.set(bytesOf(0x50, 0x4b, 0x03, 0x04));
    expect(failure(() => detectResumeFileKind(garbage)).status).toBe(415);
    expect(failure(() => detectResumeFileKind(bytesOf(0x50, 0x4b, 0x03, 0x04))).status).toBe(415);
  });

  it("rejects ZIP64 archives", () => {
    const docx = buildDocx(["Hello"]);
    const view = new DataView(docx.buffer, docx.byteOffset, docx.byteLength);
    view.setUint16(docx.length - 22 + 10, 0xffff, true);
    expect(failure(() => detectResumeFileKind(docx)).message).toContain("ZIP64");
  });
});

describe("fileExtension", () => {
  it("returns the lower-case extension of the last path segment", () => {
    expect(fileExtension("CV.PDF")).toBe(".pdf");
    expect(fileExtension("my.resume.final.docx")).toBe(".docx");
    expect(fileExtension("C:\\Users\\me\\cv.docx")).toBe(".docx");
    expect(fileExtension("dir.pdf/cv")).toBe("");
    expect(fileExtension("noextension")).toBe("");
    expect(fileExtension(".hidden")).toBe("");
    expect(fileExtension("")).toBe("");
  });
});

describe("assertClaimsMatchBytes", () => {
  it("accepts consistent claims, including missing or generic MIME types", () => {
    expect(() => assertClaimsMatchBytes("pdf", { mimeType: "application/pdf", fileName: "cv.pdf" })).not.toThrow();
    expect(() => assertClaimsMatchBytes("pdf", { mimeType: "APPLICATION/PDF; charset=binary", fileName: "CV.PDF" })).not.toThrow();
    expect(() => assertClaimsMatchBytes("pdf", { mimeType: "", fileName: "cv.pdf" })).not.toThrow();
    expect(() => assertClaimsMatchBytes("pdf", { mimeType: "application/octet-stream", fileName: "cv.pdf" })).not.toThrow();
    expect(() => assertClaimsMatchBytes("docx", { mimeType: RESUME_MIME_TYPES.docx, fileName: "cv.docx" })).not.toThrow();
  });

  it("rejects a MIME type that contradicts the bytes", () => {
    const error = failure(() => assertClaimsMatchBytes("pdf", { mimeType: RESUME_MIME_TYPES.docx, fileName: "cv.pdf" }));
    expect(error.status).toBe(415);
    expect(failure(() => assertClaimsMatchBytes("docx", { mimeType: "image/png", fileName: "cv.docx" })).status).toBe(415);
    expect(failure(() => assertClaimsMatchBytes("pdf", { mimeType: "text/html", fileName: "cv.pdf" })).status).toBe(415);
  });

  it("rejects a file extension that contradicts the bytes", () => {
    expect(failure(() => assertClaimsMatchBytes("pdf", { mimeType: "application/pdf", fileName: "cv.docx" })).status).toBe(415);
    expect(failure(() => assertClaimsMatchBytes("pdf", { mimeType: "", fileName: "cv" })).status).toBe(415);
    expect(failure(() => assertClaimsMatchBytes("pdf", { mimeType: "", fileName: "cv.pdf.exe" })).status).toBe(415);
    expect(failure(() => assertClaimsMatchBytes("docx", { mimeType: "", fileName: "cv.doc" })).status).toBe(415);
  });
});

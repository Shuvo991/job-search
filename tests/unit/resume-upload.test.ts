import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { readResumeUpload } from "@/lib/resume/read-upload";
import { buildPdf } from "../helpers/resume-files";

const URL = "http://localhost/api/resume/parse";
const PDF_BYTES = buildPdf([["Hello"]]);

function multipart(files: Array<File | string>, field = "file", extra: Record<string, string> = {}): Request {
  const form = new FormData();
  for (const file of files) form.append(field, file);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return new Request(URL, { method: "POST", body: form });
}

const pdfFile = (name = "cv.pdf", type = "application/pdf"): File => new File([PDF_BYTES as BlobPart], name, { type });

async function failureOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to throw an AppError");
}

describe("readResumeUpload: success", () => {
  it("returns the file bytes, a sanitised name and the claimed MIME type", async () => {
    const upload = await readResumeUpload(multipart([pdfFile()]), 5 * 1024 * 1024);
    expect(upload.fileName).toBe("cv.pdf");
    expect(upload.mimeType).toBe("application/pdf");
    expect([...upload.bytes]).toEqual([...PDF_BYTES]);
  });

  it("zero-fills the bytes when wipe() is called, and wipe() is idempotent", async () => {
    const upload = await readResumeUpload(multipart([pdfFile()]), 5 * 1024 * 1024);
    expect(upload.bytes.some((byte) => byte !== 0)).toBe(true);
    upload.wipe();
    expect(upload.bytes.every((byte) => byte === 0)).toBe(true);
    expect(upload.bytes.length).toBe(PDF_BYTES.length);
    upload.wipe();
    expect(upload.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("never returns a path, markup or an over-long name", async () => {
    const names: Array<[string, string]> = [
      ["../../etc/passwd.pdf", "passwd.pdf"],
      ["C:\\Users\\me\\My CV.pdf", "My CV.pdf"],
      ["  My CV (final).pdf ", "My CV (final).pdf"],
      [".htaccess.pdf", "htaccess.pdf"],
      ["<b>bold</b>.pdf", "bold.pdf"],
    ];
    for (const [given, expected] of names) {
      const upload = await readResumeUpload(multipart([pdfFile(given)]), 1024 * 1024);
      expect(upload.fileName, given).toBe(expected);
    }
    const long = await readResumeUpload(multipart([pdfFile(`${"a".repeat(400)}.pdf`)]), 1024 * 1024);
    expect(long.fileName.length).toBeLessThanOrEqual(120);
  });

  it("ignores unrelated form fields (within a limit)", async () => {
    const upload = await readResumeUpload(multipart([pdfFile()], "file", { note: "hello" }), 1024 * 1024);
    expect(upload.fileName).toBe("cv.pdf");
  });
});

describe("readResumeUpload: rejections", () => {
  it("rejects a request that is not multipart/form-data with 415", async () => {
    const json = new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const error = await failureOf(() => readResumeUpload(json, 1024));
    expect(error.status).toBe(415);
    const plain = new Request(URL, { method: "POST", body: "just text" });
    expect((await failureOf(() => readResumeUpload(plain, 1024))).status).toBe(415);
  });

  it("rejects a file over the limit with 413", async () => {
    const error = await failureOf(() => readResumeUpload(multipart([new File([new Uint8Array(2_000)], "cv.pdf")]), 1_000));
    expect(error.status).toBe(413);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(error.message).toContain("limit");
  });

  it("stops reading a body far beyond the limit with 413", async () => {
    const error = await failureOf(() => readResumeUpload(multipart([new File([new Uint8Array(300_000)], "cv.pdf")]), 1_000));
    expect(error.status).toBe(413);
  });

  it("accepts a file of exactly the limit", async () => {
    const exact = new File([new Uint8Array(1_000).fill(0x61)], "cv.pdf");
    const upload = await readResumeUpload(multipart([exact]), 1_000);
    expect(upload.bytes.length).toBe(1_000);
  });

  it("rejects an empty file with 400", async () => {
    const error = await failureOf(() => readResumeUpload(multipart([new File([], "cv.pdf")]), 1024));
    expect(error.status).toBe(400);
  });

  it("rejects a missing file field, or a text value in its place, with 400", async () => {
    const missing = await failureOf(() => readResumeUpload(multipart([pdfFile()], "resume"), 1024 * 1024));
    expect(missing.status).toBe(400);
    expect(missing.code).toBe("VALIDATION_ERROR");
    const text = await failureOf(() => readResumeUpload(multipart(["not a file"]), 1024 * 1024));
    expect(text.status).toBe(400);
  });

  it("rejects more than one file with 400", async () => {
    const error = await failureOf(() => readResumeUpload(multipart([pdfFile("a.pdf"), pdfFile("b.pdf")]), 1024 * 1024));
    expect(error.status).toBe(400);
  });

  it("rejects too many form fields with 400", async () => {
    const extra = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, "x"]));
    const error = await failureOf(() => readResumeUpload(multipart([pdfFile()], "file", extra), 1024 * 1024));
    expect(error.status).toBe(400);
  });

  it("rejects a malformed or empty multipart body with 400", async () => {
    const garbage = new Request(URL, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
      body: "this is not multipart at all",
    });
    expect((await failureOf(() => readResumeUpload(garbage, 1024))).status).toBe(400);
    const noBody = new Request(URL, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=xyz" } });
    expect((await failureOf(() => readResumeUpload(noBody, 1024))).status).toBe(400);
  });
});

import { NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-handler";
import { getEnv } from "@/lib/env";
import { UnprocessableEntityError } from "@/lib/errors";
import { extractResumeText } from "@/lib/resume/extract-text";
import { assertClaimsMatchBytes, detectResumeFileKind, RESUME_MIME_TYPES } from "@/lib/resume/file-signature";
import { readResumeUpload } from "@/lib/resume/read-upload";
import { countWords, MAX_RESUME_CHARS, normalizeResumeText } from "@/lib/resume/text";
import { RESUME_MAX_BYTES, type ParsedResumeResponse } from "@/schemas/resume";

// pdf-parse and mammoth need Node APIs, and every request carries a private document.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/resume/parse   (Content-Type: multipart/form-data, one PDF or DOCX in field `file`)
 *
 * Pipeline: read into memory with a hard size cap -> verify the type from the file's magic bytes
 * (the client's MIME type and file name must agree with it) -> extract text -> normalise ->
 * wipe every buffer we own, whether or not anything failed. Nothing is written to disk.
 *
 * 200 { fileName, fileType, mimeType, sizeBytes, pageCount, wordCount, truncated, text }
 * 400 empty/duplicated/missing file | 413 too large | 415 not a PDF/DOCX | 422 unreadable or no text
 */
export const POST = withApiHandler(async (req) => {
  const maxBytes = Math.min(getEnv().MAX_UPLOAD_BYTES, RESUME_MAX_BYTES);
  const upload = await readResumeUpload(req, maxBytes);

  try {
    const kind = detectResumeFileKind(upload.bytes);
    assertClaimsMatchBytes(kind, { mimeType: upload.mimeType, fileName: upload.fileName });

    const extracted = await extractResumeText(upload.bytes, kind);
    const text = normalizeResumeText(extracted.text);
    if (text === "") {
      throw new UnprocessableEntityError(
        "No selectable text was found. If this is a scanned or image-only file, export a text-based PDF or upload a DOCX.",
        { reason: "no_text" },
      );
    }

    const body: ParsedResumeResponse = {
      fileName: upload.fileName,
      fileType: kind,
      mimeType: RESUME_MIME_TYPES[kind],
      sizeBytes: upload.bytes.byteLength,
      pageCount: extracted.pageCount ?? null,
      wordCount: countWords(text),
      truncated: extracted.truncated || text.length >= MAX_RESUME_CHARS,
      text,
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } finally {
    upload.wipe();
  }
});

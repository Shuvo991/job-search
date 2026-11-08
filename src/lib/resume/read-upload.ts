/**
 * Receive a multipart/form-data resume upload entirely in memory.
 *
 *  - Nothing is ever written to disk, so there is no temporary file to leave behind.
 *  - The request body is read through a counting reader that aborts as soon as the limit is
 *    exceeded, so an oversized upload never gets buffered in full.
 *  - The raw multipart buffer is zero-filled as soon as it has been parsed; the file bytes handed
 *    back are zero-filled by the caller's `wipe()` in a `finally` block.
 *
 * Honest limit: the `File` object created by the multipart parser is managed by the runtime and
 * cannot be overwritten from JavaScript. We drop every reference to it so the garbage collector can
 * reclaim it, and we wipe every copy that we own.
 */
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from "@/lib/errors";
import { sanitizeInline } from "@/lib/sanitize";
import { parseWith } from "@/lib/validation";
import { resumeUploadSchema } from "@/schemas/resume";

/** Room for multipart boundaries and headers on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_FORM_FIELDS = 10;
const MAX_FILE_NAME_CHARS = 120;

export interface ResumeUpload {
  /** The file's bytes. Owned by the caller; call `wipe()` when done. */
  bytes: Uint8Array;
  /** Sanitised base name, safe to echo back or log. Never used as a path. */
  fileName: string;
  /** MIME type claimed by the client (untrusted). */
  mimeType: string;
  /** Overwrite the file bytes with zeros. Safe to call more than once. */
  wipe: () => void;
}

async function readBodyWithLimit(req: Request, maxBytes: number, maxFileBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!req.body) throw new BadRequestError("The request has no body");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError(`The upload exceeds the ${formatMegabytes(maxFileBytes)} limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  return body;
}

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

function safeFileName(raw: string): string {
  const base = sanitizeInline(raw).split(/[\\/]/).pop() ?? "";
  const trimmed = base.replace(/^\.+/, "").slice(0, MAX_FILE_NAME_CHARS).trim();
  return trimmed === "" ? "resume" : trimmed;
}

/**
 * Read and validate a single-file multipart upload (field name `file`).
 * 415 for a wrong Content-Type, 413 when too large, 400 for a missing/empty/duplicated file.
 */
export async function readResumeUpload(req: Request, maxFileBytes: number): Promise<ResumeUpload> {
  const contentType = (req.headers.get("content-type") ?? "").trim();
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new UnsupportedMediaTypeError("Content-Type must be multipart/form-data");
  }

  const maxBodyBytes = maxFileBytes + MULTIPART_OVERHEAD_BYTES;
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new PayloadTooLargeError(`The upload exceeds the ${formatMegabytes(maxFileBytes)} limit`);
  }

  const body = await readBodyWithLimit(req, maxBodyBytes, maxFileBytes);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new BadRequestError("The multipart body is malformed");
  } finally {
    body.fill(0);
  }

  const fields = [...form.keys()];
  if (fields.length > MAX_FORM_FIELDS) throw new BadRequestError("Too many form fields");
  if (form.getAll("file").length > 1) throw new BadRequestError("Upload exactly one file in the 'file' field");

  const { file } = parseWith(resumeUploadSchema, { file: form.get("file") });
  if (file.size === 0) throw new BadRequestError("The uploaded file is empty");
  if (file.size > maxFileBytes) {
    throw new PayloadTooLargeError(`The file exceeds the ${formatMegabytes(maxFileBytes)} limit`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    bytes,
    fileName: safeFileName(file.name),
    mimeType: file.type,
    wipe: () => {
      bytes.fill(0);
    },
  };
}

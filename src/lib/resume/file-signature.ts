/**
 * Strict file-type verification for resume uploads.
 *
 * The client-supplied MIME type and file name are NEVER trusted on their own. The type is decided
 * from the file's leading bytes ("magic bytes"):
 *
 *  - PDF  : starts with "%PDF-<digit>.<digit>"
 *  - DOCX : starts with the ZIP signature "PK\x03\x04" AND the ZIP's central directory lists the
 *           parts every Word document has ([Content_Types].xml, word/document.xml). Any other ZIP
 *           (xlsx, pptx, jar, a renamed archive) is rejected.
 *  - Legacy .doc (OLE2) and everything else is rejected.
 *
 * The ZIP is inspected through its central directory only (names and declared sizes); nothing is
 * decompressed here. Declared sizes are checked against limits so a "zip bomb" is refused before
 * mammoth ever inflates it. Macro-enabled documents (word/vbaProject.bin) and encrypted entries
 * are refused as well.
 */
import { BadRequestError, UnsupportedMediaTypeError } from "@/lib/errors";

export type ResumeFileKind = "pdf" | "docx";

export const RESUME_MIME_TYPES: Readonly<Record<ResumeFileKind, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const RESUME_EXTENSIONS: Readonly<Record<ResumeFileKind, string>> = {
  pdf: ".pdf",
  docx: ".docx",
};

/** Limits applied to the DOCX (ZIP) container before it is decompressed. */
export const ZIP_LIMITS = {
  maxEntries: 2_000,
  maxEntryUncompressedBytes: 25 * 1024 * 1024,
  maxTotalUncompressedBytes: 60 * 1024 * 1024,
} as const;

const PDF_HEADER = /^%PDF-\d\.\d/;
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04] as const;
const OLE2_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_EOCD_COMMENT = 0xffff;
const CENTRAL_HEADER_FIXED = 46;

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function asciiPrefix(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < Math.min(length, bytes.length); i += 1) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/** Read the entry list of a ZIP from its central directory without decompressing anything. */
export function readZipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => new UnsupportedMediaTypeError("The file is not a valid .docx document");

  if (bytes.length < EOCD_MIN_LENGTH) throw invalid();

  // The End Of Central Directory record sits at the end, followed by an optional comment.
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_MIN_LENGTH - MAX_EOCD_COMMENT);
  for (let i = bytes.length - EOCD_MIN_LENGTH; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid();

  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  // ZIP64 markers: far beyond what a resume (<= 5 MB) can need.
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new UnsupportedMediaTypeError("ZIP64 archives are not supported");
  }
  if (entryCount === 0 || entryCount > ZIP_LIMITS.maxEntries) {
    throw new BadRequestError("The .docx archive has an unreasonable number of parts");
  }
  if (directoryOffset + directorySize > eocd) throw invalid();

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntryInfo[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_HEADER_FIXED > eocd) throw invalid();
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) throw invalid();

    const flags = view.getUint16(cursor + 8, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);

    const nameStart = cursor + CENTRAL_HEADER_FIXED;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > eocd) throw invalid();

    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      compressedSize,
      uncompressedSize,
      encrypted: (flags & 0x1) !== 0,
    });
    cursor = next;
  }
  return entries;
}

/** Throw unless the ZIP is a plain, safe-to-open Word document. */
export function assertSafeDocx(entries: readonly ZipEntryInfo[]): void {
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) {
    throw new UnsupportedMediaTypeError("The file is not a Word (.docx) document");
  }
  if (names.has("word/vbaProject.bin")) {
    throw new UnsupportedMediaTypeError("Macro-enabled Word documents are not accepted");
  }

  let total = 0;
  for (const entry of entries) {
    if (entry.encrypted) {
      throw new UnsupportedMediaTypeError("Encrypted or password-protected documents are not accepted");
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(entry.name) || /^[\\/]/.test(entry.name)) {
      throw new UnsupportedMediaTypeError("The .docx archive contains unsafe part names");
    }
    if (entry.uncompressedSize > ZIP_LIMITS.maxEntryUncompressedBytes) {
      throw new BadRequestError("The .docx contains a part that is too large when unpacked");
    }
    total += entry.uncompressedSize;
    if (total > ZIP_LIMITS.maxTotalUncompressedBytes) {
      throw new BadRequestError("The .docx is too large when unpacked");
    }
  }
}

/**
 * Decide the file type from its bytes. Throws UnsupportedMediaTypeError (415) when the file is
 * not a PDF or a plain DOCX.
 */
export function detectResumeFileKind(bytes: Uint8Array): ResumeFileKind {
  if (bytes.length === 0) throw new BadRequestError("The uploaded file is empty");

  if (PDF_HEADER.test(asciiPrefix(bytes, 8))) return "pdf";

  if (startsWith(bytes, ZIP_LOCAL_HEADER)) {
    assertSafeDocx(readZipEntries(bytes));
    return "docx";
  }

  if (startsWith(bytes, OLE2_HEADER)) {
    throw new UnsupportedMediaTypeError("Legacy .doc files are not supported; save the file as .docx or PDF");
  }

  throw new UnsupportedMediaTypeError("Only PDF and DOCX resumes are accepted");
}

/** The file name's extension in lower case (".pdf"), or "" when it has none. */
export function fileExtension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Cross-check what the client CLAIMS against what the bytes ARE. A missing or generic
 * (application/octet-stream) MIME type is tolerated because some clients send nothing useful, but
 * a claim that contradicts the bytes is refused.
 */
export function assertClaimsMatchBytes(
  kind: ResumeFileKind,
  claimed: { mimeType: string; fileName: string },
): void {
  const mime = claimed.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "" && mime !== "application/octet-stream" && mime !== RESUME_MIME_TYPES[kind]) {
    throw new UnsupportedMediaTypeError("The file content does not match its declared type");
  }
  const extension = fileExtension(claimed.fileName);
  if (extension !== RESUME_EXTENSIONS[kind]) {
    throw new UnsupportedMediaTypeError(`The file extension must be ${RESUME_EXTENSIONS[kind]} for this content`);
  }
}

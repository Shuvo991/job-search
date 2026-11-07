import type { z } from "zod";
import {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
  type ValidationIssue,
} from "@/lib/errors";

export const DEFAULT_MAX_JSON_BYTES = 1_048_576; // 1 MiB

export function zodIssuesToDetails(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/** Validate arbitrary data with a Zod schema; throws ValidationError (HTTP 400) on failure. */
export function parseWith<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(zodIssuesToDetails(result.error));
  }
  return result.data;
}

/** Validate URL query parameters. */
export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.output<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return parseWith(schema, params);
}

async function readTextWithLimit(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read, size-limit and validate a JSON request body.
 * 415 for a wrong Content-Type, 413 when too large, 400 for malformed JSON or schema failures.
 */
export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  options: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;

  const contentType = (req.headers.get("content-type") ?? "").trim();
  if (!/^application\/json(\s*;.*)?$/i.test(contentType)) {
    throw new UnsupportedMediaTypeError("Content-Type must be application/json");
  }

  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`);
  }

  const text = await readTextWithLimit(req, maxBytes);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BadRequestError("Malformed JSON body");
  }
  return parseWith(schema, json);
}

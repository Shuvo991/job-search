import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { zodIssuesToDetails } from "@/lib/validation";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** Default context type for Next.js route handlers (dynamic route params are a Promise). */
export interface RouteContext {
  params: Promise<Record<string, string | string[] | undefined>>;
}

export interface HandlerMeta {
  requestId: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function resolveRequestId(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

// Prisma errors are detected structurally so this module never imports the generated client.
function prismaErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return name === "PrismaClientKnownRequestError" && typeof code === "string" ? code : undefined;
}

// notFound()/redirect() from next/navigation work by throwing; never swallow those.
function isNextControlFlowError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { digest } = err as { digest?: unknown };
  return typeof digest === "string" && /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(digest);
}

/** Map known error shapes to a client-safe AppError; returns undefined for anything unexpected. */
function normalizeError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new ValidationError(zodIssuesToDetails(err));

  switch (prismaErrorCode(err)) {
    case "P2002":
      return new ConflictError("A record with these values already exists");
    case "P2003":
      return new ConflictError("The record is referenced by, or references, another record");
    case "P2025":
      return new NotFoundError();
    default:
      return undefined;
  }
}

function logError(requestId: string, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  // Server-side only: the stack trace is never sent to the client.
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      name: error.name,
      message: error.message,
      stack: error.stack,
    }),
  );
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: unknown,
  requestId: string,
): NextResponse<ApiErrorBody> {
  const error: ApiErrorBody["error"] = { code, message, requestId };
  if (details !== undefined) error.details = details;
  return NextResponse.json<ApiErrorBody>(
    { error },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

/** Convert any thrown value into the standard JSON error response. */
export function toErrorResponse(err: unknown, requestId: string): NextResponse<ApiErrorBody> {
  const known = normalizeError(err);
  if (known) {
    if (known.status >= 500) logError(requestId, err);
    return errorResponse(known.status, known.code, known.message, known.details, requestId);
  }
  logError(requestId, err);
  return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred", undefined, requestId);
}

/**
 * Wrap every API route handler with this. It assigns a request id and converts thrown
 * errors (Zod validation, AppError subclasses, Prisma known errors, anything else) into
 * one consistent JSON shape without leaking internals.
 */
export function withApiHandler<TContext = RouteContext>(
  handler: (req: NextRequest, ctx: TContext, meta: HandlerMeta) => Promise<Response> | Response,
): (req: NextRequest, ctx: TContext) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = resolveRequestId(req);
    try {
      const response = await handler(req, ctx, { requestId });
      try {
        response.headers.set("x-request-id", requestId);
      } catch {
        // Some Response objects have immutable headers; the id is a nicety, not required.
      }
      return response;
    } catch (err) {
      if (isNextControlFlowError(err)) throw err;
      return toErrorResponse(err, requestId);
    }
  };
}

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withApiHandler, type ApiErrorBody } from "@/lib/api-handler";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { parseJsonBody } from "@/lib/validation";

const bodySchema = z.object({ name: z.string().min(2) });

function jsonRequest(body: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new NextRequest("http://localhost/api/test", { method: "POST", headers, body });
}

const ctx = { params: Promise.resolve({}) };

describe("withApiHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes successful responses through and adds a request id", async () => {
    const handler = withApiHandler(async () => Response.json({ ok: true }));
    const res = await handler(new NextRequest("http://localhost/api/test"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns 400 with field-level issues when Zod validation fails", async () => {
    const handler = withApiHandler(async (req) => Response.json(await parseJsonBody(req, bodySchema)));
    const res = await handler(jsonRequest(JSON.stringify({ name: "a" })), ctx);
    const body = (await res.json()) as ApiErrorBody;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([expect.objectContaining({ path: "name" })]);
  });

  it("returns 400 for malformed JSON", async () => {
    const handler = withApiHandler(async (req) => Response.json(await parseJsonBody(req, bodySchema)));
    const res = await handler(jsonRequest("{not json"), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe("BAD_REQUEST");
  });

  it("returns 415 when Content-Type is not JSON", async () => {
    const handler = withApiHandler(async (req) => Response.json(await parseJsonBody(req, bodySchema)));
    const res = await handler(jsonRequest("name=ab", { "content-type": "text/plain" }), ctx);
    expect(res.status).toBe(415);
  });

  it("returns 413 when the body exceeds the size limit", async () => {
    const handler = withApiHandler(async (req) =>
      Response.json(await parseJsonBody(req, bodySchema, { maxBytes: 10 })),
    );
    const res = await handler(jsonRequest(JSON.stringify({ name: "far too long for the limit" })), ctx);
    expect(res.status).toBe(413);
  });

  it("maps AppError subclasses to their status codes", async () => {
    const notFound = withApiHandler(async () => {
      throw new NotFoundError("Job not found");
    });
    const conflict = withApiHandler(async () => {
      throw new ConflictError();
    });
    const req = new NextRequest("http://localhost/api/test");
    expect((await notFound(req, ctx)).status).toBe(404);
    expect((await conflict(req, ctx)).status).toBe(409);
  });

  it("maps Prisma known errors (P2002 -> 409, P2025 -> 404)", async () => {
    const prismaError = (code: string) =>
      Object.assign(new Error("db error"), { name: "PrismaClientKnownRequestError", code });
    const req = new NextRequest("http://localhost/api/test");

    const unique = withApiHandler(async () => {
      throw prismaError("P2002");
    });
    const missing = withApiHandler(async () => {
      throw prismaError("P2025");
    });
    expect((await unique(req, ctx)).status).toBe(409);
    expect((await missing(req, ctx)).status).toBe(404);
  });

  it("hides internals for unexpected errors", async () => {
    const handler = withApiHandler(async () => {
      throw new Error("secret database path /home/me/data/dev.db");
    });
    const res = await handler(new NextRequest("http://localhost/api/test"), ctx);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("stack");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it.each(["short", "has spaces and <symbols>", "x".repeat(65)])(
    "replaces an invalid incoming x-request-id (%#)",
    async (incoming) => {
      const handler = withApiHandler(async () => Response.json({ ok: true }));
      const req = new NextRequest("http://localhost/api/test", { headers: { "x-request-id": incoming } });
      const res = await handler(req, ctx);
      const id = res.headers.get("x-request-id");
      expect(id).not.toBe(incoming);
      expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    },
  );

  it("keeps a valid incoming x-request-id", async () => {
    const handler = withApiHandler(async () => Response.json({ ok: true }));
    const req = new NextRequest("http://localhost/api/test", { headers: { "x-request-id": "req-12345678" } });
    const res = await handler(req, ctx);
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
  });
});

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));

import { GET } from "@/app/api/health/route";

const ctx = { params: Promise.resolve({}) };

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    queryRaw.mockReset();
    vi.restoreAllMocks();
  });

  it("returns 200 when the database responds", async () => {
    queryRaw.mockResolvedValue([{ 1: 1 }]);
    const res = await GET(new NextRequest("http://localhost/api/health"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("returns 503 in the standard error shape when the database fails", async () => {
    queryRaw.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
    const res = await GET(new NextRequest("http://localhost/api/health"), ctx);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toContain("SQLITE_CANTOPEN");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
  });
});

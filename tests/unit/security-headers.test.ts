import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

async function headerMap(): Promise<Map<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === "/:path*");
  expect(rule).toBeDefined();
  return new Map((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

describe("security headers (next.config.ts)", () => {
  it("sets the required headers on every route", async () => {
    const headers = await headerMap();
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.has("Content-Security-Policy")).toBe(true);
  });

  it("has a restrictive CSP", async () => {
    const csp = (await headerMap()).get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toMatch(/\*/);
  });

  it("hides the X-Powered-By header", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

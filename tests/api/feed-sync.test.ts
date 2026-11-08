import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "@/lib/api-handler";
import { fakePrismaRows, fakeSyncLogRows, resetFakePrisma } from "../helpers/fake-prisma";

vi.mock("@/lib/db", () => import("../helpers/fake-prisma").then((module) => ({ prisma: module.fakePrisma })));

import { GET, POST } from "@/app/api/jobs/sync/route";
import { ConflictError } from "@/lib/errors";
import { getFeedStatuses, isSyncRunning, syncFeeds } from "@/lib/feed-ingestor";
import { parseFeedConfig } from "@/lib/feeds/config";
import { computeFeedDedupeHash } from "@/lib/jobs/dedupe";
import { ENGLISH_AD, GERMAN_AD, SPANISH_AD } from "../helpers/ads";

const ctx = { params: Promise.resolve({}) };

const config = parseFeedConfig({
  version: "test",
  settings: {
    userAgent: "test-agent/1.0",
    requestTimeoutMs: 5000,
    maxResponseBytes: 1_000_000,
    maxRedirects: 2,
    concurrency: 2,
    maxItemsPerFeed: 50,
    failureBackoffMinutes: 5,
  },
  feeds: [
    {
      id: "rest-feed",
      name: "Example API",
      type: "rest-json",
      url: "https://api.example.com/jobs",
      query: { limit: 50 },
      minIntervalMinutes: 60,
      attribution: "Jobs via Example API",
      itemsPath: "jobs",
      fields: {
        id: "id",
        title: "title",
        company: "company",
        url: "url",
        description: "description",
        location: "location",
        postedAt: "posted",
      },
    },
    {
      id: "rss-feed",
      name: "Example RSS",
      type: "rss",
      url: "https://rss.example.com/feed.xml",
      minIntervalMinutes: 30,
      attribution: "Powered by Example RSS",
      titleCompanySeparator: " at ",
    },
    {
      id: "off-feed",
      name: "Switched off",
      type: "rss",
      enabled: false,
      url: "https://off.example.com/feed.xml",
    },
  ],
});

const GOOD_DESCRIPTION = `<p>${ENGLISH_AD}</p><p>Requirements:</p><ul><li>5+ years of experience with TypeScript</li><li>PostgreSQL and Docker</li></ul>`;

const restJobs = [
  { id: "r1", title: "Senior Backend Engineer", company: "Acme", url: "https://acme.example/jobs/1?utm_source=feed", description: GOOD_DESCRIPTION, location: "Stockholm", posted: "2026-11-05T08:00:00Z" },
  { id: "r2", title: "Softwareentwickler (m/w/d)", company: "Beispiel GmbH", url: "https://beispiel.example/jobs/2", description: `<p>${GERMAN_AD}</p>` },
  { id: "r3", title: "Ingeniero de software", company: "Ejemplo SL", url: "https://ejemplo.example/jobs/3", description: `<p>${SPANISH_AD}</p>` },
  { id: "r4", title: "Backend Developer", company: "Nordic AB", url: "https://nordic.example/jobs/4", description: `<p>${ENGLISH_AD} Fluent in Swedish and English is required.</p>` },
  { id: "r5", title: "Regional Sales Manager", company: "Acme", url: "https://acme.example/jobs/5", description: `<p>${ENGLISH_AD}</p>` },
  { id: "r6", title: "Platform Engineer", url: "https://acme.example/jobs/6", description: `<p>${ENGLISH_AD}</p>` },
  { id: "r7", title: "Technical Product Manager", company: "Globex", url: "https://globex.example/jobs/7", description: `<p>${ENGLISH_AD} <script>alert(1)</script><img src="https://t.example/p.gif"></p>` },
];

const rssXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
  <item><title>Data Engineer at Initech</title><link>https://initech.example/jobs/9</link>
  <guid isPermaLink="true">https://initech.example/jobs/9</guid><pubDate>Fri, 06 Nov 2026 09:00:00 +0000</pubDate>
  <description><![CDATA[<p>${ENGLISH_AD} Python, SQL and Apache Airflow.</p>]]></description></item></channel></rss>`;

interface Harness {
  calls: string[];
  fetchImpl: (url: string) => Promise<Response>;
  restBody: () => string;
  setRest: (response: () => Response) => void;
}

function harness(): Harness {
  const calls: string[] = [];
  let rest = () => new Response(JSON.stringify({ jobs: restJobs }), { headers: { "content-type": "application/json" } });
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith("https://api.example.com/")) return rest();
      if (url.startsWith("https://rss.example.com/")) return new Response(rssXml);
      return new Response("unexpected", { status: 404 });
    },
    restBody: () => JSON.stringify({ jobs: restJobs }),
    setRest: (response) => {
      rest = response;
    },
  };
}

const T0 = new Date("2026-11-08T10:00:00Z");
let clock = T0;
const now = () => clock;
const minutesLater = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeEach(() => {
  resetFakePrisma();
  clock = T0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function resultOf(summary: Awaited<ReturnType<typeof syncFeeds>>, feedId: string) {
  const result = summary.feeds.find((feed) => feed.feedId === feedId);
  if (!result) throw new Error(`no result for ${feedId}`);
  return result;
}

describe("syncFeeds", () => {
  it("imports English tech jobs and counts everything it filters out", async () => {
    const h = harness();
    const summary = await syncFeeds({ config, now, fetchImpl: h.fetchImpl });

    expect(resultOf(summary, "rest-feed")).toMatchObject({
      status: "success",
      fetched: 7,
      imported: 2,
      duplicates: 0,
      invalid: 1,
      filtered: { language: 2, requiredLanguage: 1, role: 1 },
    });
    expect(resultOf(summary, "rss-feed")).toMatchObject({ status: "success", fetched: 1, imported: 1 });
    expect(summary.feeds.map((feed) => feed.feedId)).toEqual(["rest-feed", "rss-feed"]); // disabled feed not run
    expect(summary.totals).toMatchObject({
      imported: 3,
      invalid: 1,
      filteredOut: 4,
      filtered: { language: 2, requiredLanguage: 1, role: 1 },
      feedsSynced: 2,
      feedsFailed: 0,
    });
    expect(h.calls).toEqual(["https://api.example.com/jobs?limit=50", "https://rss.example.com/feed.xml"]);
    expect(isSyncRunning()).toBe(false);
  });

  it("stores source, link, attribution, skills and a feed fingerprint on each job", async () => {
    await syncFeeds({ config, now, fetchImpl: harness().fetchImpl });
    const rows = fakePrismaRows();
    expect(rows).toHaveLength(3);

    const backend = rows.find((row) => row["title"] === "Senior Backend Engineer");
    expect(backend).toMatchObject({
      company: "Acme",
      sourceName: "Example API",
      sourceUrl: "https://acme.example/jobs/1", // tracking parameter removed
      applyUrl: "https://acme.example/jobs/1",
      attribution: "Jobs via Example API",
      externalId: "r1",
      location: "Stockholm",
      roleCategory: "SOFTWARE_ENGINEER",
      seniority: "SENIOR",
    });
    expect(backend?.["dedupeHash"]).toBe(
      computeFeedDedupeHash({ company: "Acme", title: "Senior Backend Engineer", externalUrl: "https://acme.example/jobs/1" }),
    );
    expect(backend?.["skills"]).toEqual(expect.arrayContaining(["TypeScript", "Node.js", "PostgreSQL", "Docker"]));
    expect(backend?.["requirements"]).toContain("5+ years of experience with TypeScript");

    const rss = rows.find((row) => row["sourceName"] === "Example RSS");
    expect(rss).toMatchObject({ title: "Data Engineer", company: "Initech", attribution: "Powered by Example RSS" });
    expect(rss?.["skills"]).toEqual(expect.arrayContaining(["Python", "SQL", "Apache Airflow"]));
  });

  it("stores no markup, scripts or tracking pixels", async () => {
    await syncFeeds({ config, now, fetchImpl: harness().fetchImpl });
    for (const row of fakePrismaRows()) {
      expect(String(row["description"])).not.toMatch(/<|alert\(1\)|t\.example/);
      expect(String(row["title"])).not.toMatch(/</);
    }
  });

  it("never stores the jobs it rejected", async () => {
    await syncFeeds({ config, now, fetchImpl: harness().fetchImpl });
    const titles = fakePrismaRows().map((row) => row["title"]);
    expect(titles).not.toContain("Softwareentwickler (m/w/d)");
    expect(titles).not.toContain("Ingeniero de software");
    expect(titles).not.toContain("Backend Developer"); // required fluent Swedish
    expect(titles).not.toContain("Regional Sales Manager");
    expect(titles).not.toContain("Platform Engineer"); // no company
  });

  it("re-syncing never creates duplicates", async () => {
    const h = harness();
    await syncFeeds({ config, now, fetchImpl: h.fetchImpl });
    expect(fakePrismaRows()).toHaveLength(3);

    clock = minutesLater(61);
    const again = await syncFeeds({ config, now, fetchImpl: h.fetchImpl });
    expect(resultOf(again, "rest-feed")).toMatchObject({ imported: 0, duplicates: 2 });
    expect(resultOf(again, "rss-feed")).toMatchObject({ imported: 0, duplicates: 1 });
    expect(fakePrismaRows()).toHaveLength(3);
  });

  it("de-duplicates the same ad appearing twice in one feed", async () => {
    const h = harness();
    const first = restJobs[0];
    h.setRest(() => new Response(JSON.stringify({ jobs: [first, { ...first, id: "r1-copy", url: `${first?.url}&utm_medium=x` }] })));
    const summary = await syncFeeds({ config, now, fetchImpl: h.fetchImpl, feedIds: ["rest-feed"] });
    expect(resultOf(summary, "rest-feed")).toMatchObject({ imported: 1, duplicates: 1 });
    expect(fakePrismaRows()).toHaveLength(1);
  });

  it("rate limits each feed and does not even contact it inside the cooldown", async () => {
    const h = harness();
    await syncFeeds({ config, now, fetchImpl: h.fetchImpl });
    const callsAfterFirst = h.calls.length;

    clock = minutesLater(10);
    const second = await syncFeeds({ config, now, fetchImpl: h.fetchImpl });
    expect(h.calls.length).toBe(callsAfterFirst);
    expect(resultOf(second, "rest-feed")).toMatchObject({ status: "rate_limited", retryAfterSeconds: 50 * 60 });
    expect(resultOf(second, "rss-feed")).toMatchObject({ status: "rate_limited", retryAfterSeconds: 20 * 60 });
    expect(second.totals).toMatchObject({ imported: 0, feedsSynced: 0, feedsSkipped: 2 });

    // The RSS feed (30 min) is free again before the REST feed (60 min).
    clock = minutesLater(31);
    const third = await syncFeeds({ config, now, fetchImpl: h.fetchImpl });
    expect(resultOf(third, "rest-feed").status).toBe("rate_limited");
    expect(resultOf(third, "rss-feed").status).toBe("success");
  });

  it("logs a failing feed, keeps the others running and backs off briefly", async () => {
    const h = harness();
    h.setRest(() => new Response("boom", { status: 500 }));
    const summary = await syncFeeds({ config, now, fetchImpl: h.fetchImpl });

    expect(resultOf(summary, "rest-feed")).toMatchObject({
      status: "error",
      error: "api.example.com answered HTTP 500.",
      imported: 0,
    });
    expect(resultOf(summary, "rss-feed")).toMatchObject({ status: "success", imported: 1 });
    expect(summary.totals).toMatchObject({ feedsFailed: 1, feedsSynced: 1 });

    const logs = fakeSyncLogRows();
    expect(logs).toHaveLength(2);
    expect(logs.find((log) => log["feedId"] === "rest-feed")).toMatchObject({
      status: "ERROR",
      error: "api.example.com answered HTTP 500.",
      feedName: "Example API",
    });
    expect(logs.find((log) => log["feedId"] === "rss-feed")).toMatchObject({ status: "SUCCESS", imported: 1 });

    // 2 minutes later: still backing off. 6 minutes later: retried (and now healthy).
    clock = minutesLater(2);
    expect(resultOf(await syncFeeds({ config, now, fetchImpl: h.fetchImpl, feedIds: ["rest-feed"] }), "rest-feed").status).toBe("rate_limited");
    h.setRest(() => new Response(JSON.stringify({ jobs: restJobs })));
    clock = minutesLater(6);
    expect(resultOf(await syncFeeds({ config, now, fetchImpl: h.fetchImpl, feedIds: ["rest-feed"] }), "rest-feed")).toMatchObject({
      status: "success",
      imported: 2,
    });
  });

  const badResponses: Array<[string, () => Response, RegExp]> = [
    ["is not JSON", () => new Response("<html>nope</html>"), /not valid JSON/],
    ["has no jobs list", () => new Response(JSON.stringify({ results: [] })), /itemsPath/],
    ["redirects somewhere forbidden", () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }), /not allowed/],
    ["never answers", () => Promise.reject(Object.assign(new Error("slow"), { name: "TimeoutError" })) as never, /No response/],
  ];
  it.each(badResponses)("reports a feed whose response %s as a clear error", async (_label, response, message) => {
    const h = harness();
    h.setRest(response);
    const summary = await syncFeeds({ config, now, fetchImpl: h.fetchImpl, feedIds: ["rest-feed"] });
    const result = resultOf(summary, "rest-feed");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(message);
    expect(fakePrismaRows()).toHaveLength(0);
  });

  it("syncs only the requested feeds, and reports a switched-off feed without fetching it", async () => {
    const h = harness();
    const summary = await syncFeeds({ config, now, fetchImpl: h.fetchImpl, feedIds: ["rss-feed", "off-feed"] });
    expect(summary.feeds.map((feed) => [feed.feedId, feed.status])).toEqual([
      ["rss-feed", "success"],
      ["off-feed", "disabled"],
    ]);
    expect(h.calls).toEqual(["https://rss.example.com/feed.xml"]);
  });

  it("allows only one sync at a time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness();
    const slow = (url: string) => gate.then(() => h.fetchImpl(url));

    const first = syncFeeds({ config, now, fetchImpl: slow, feedIds: ["rss-feed"] });
    expect(isSyncRunning()).toBe(true);
    await expect(syncFeeds({ config, now, fetchImpl: h.fetchImpl })).rejects.toBeInstanceOf(ConflictError);

    release();
    await first;
    expect(isSyncRunning()).toBe(false);
  });

  it("releases the lock even when something unexpected throws", async () => {
    const broken = { ...config, feeds: [] as typeof config.feeds };
    Object.defineProperty(broken, "settings", {
      get() {
        throw new Error("boom");
      },
    });
    await expect(syncFeeds({ config: broken, now })).rejects.toThrow("boom");
    expect(isSyncRunning()).toBe(false);
  });

  it("describes every feed with its last run and next allowed time", async () => {
    await syncFeeds({ config, now, fetchImpl: harness().fetchImpl });
    clock = minutesLater(10);
    const statuses = await getFeedStatuses({ config, now });
    const rest = statuses.find((feed) => feed.id === "rest-feed");
    expect(rest).toMatchObject({
      name: "Example API",
      attribution: "Jobs via Example API",
      lastRun: { status: "SUCCESS", imported: 2, filtered: 4, duplicates: 0, invalid: 1 },
    });
    expect(rest?.nextAllowedAt).toBe(minutesLater(60).toISOString());
    expect(statuses.find((feed) => feed.id === "off-feed")).toMatchObject({ enabled: false, lastRun: null, nextAllowedAt: null });
  });
});

describe("/api/jobs/sync", () => {
  const url = "http://localhost/api/jobs/sync";
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    POST(
      new NextRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      ctx,
    );
  const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;

  it("GET lists the configured feeds without contacting any of them", async () => {
    const res = await GET(new NextRequest(url), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feeds: Array<{ id: string; lastRun: unknown }>;
      running: boolean;
      autoSync: { enabled: boolean; intervalMinutes: number };
    };
    expect(body.running).toBe(false);
    expect(body.autoSync).toEqual({ enabled: true, intervalMinutes: 180 });
    expect(body.feeds.map((feed) => feed.id)).toEqual(expect.arrayContaining(["jobicy", "himalayas", "teamtailor:tibber"]));
    expect(body.feeds.every((feed) => feed.lastRun === null)).toBe(true);
  });

  it("POST with an empty feed list does nothing and returns zero totals", async () => {
    const res = await send({ feedIds: [] }, { origin: "http://localhost" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ feeds: [], totals: { imported: 0, filteredOut: 0 } });
  });

  it("rejects requests that come from another site", async () => {
    const res = await send({}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("FORBIDDEN");
    expect(fakeSyncLogRows()).toHaveLength(0);
  });

  it("rejects unknown feeds, unknown fields, bad JSON and wrong content types", async () => {
    const unknown = await send({ feedIds: ["nope"] });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).details).toEqual([{ path: "feedIds", message: 'Unknown feed "nope"', code: "custom" }]);

    expect((await send({ force: true })).status).toBe(400);
    expect((await send("{not json")).status).toBe(400);
    expect((await send("{}", { "content-type": "text/plain" })).status).toBe(415);
  });
});

import { describe, expect, it } from "vitest";
import { FeedParseError, parseFeedBody, parseFeedDate, readPath, type RawFeedItem } from "@/lib/feeds/adapters";
import { FeedConfigError, getFeedConfig, parseFeedConfig, type ResolvedFeed } from "@/lib/feeds/config";
import { assertFetchableUrl, FeedFetchError, fetchFeedText } from "@/lib/feeds/fetcher";
import { buildFeedJob, canonicalizeUrl, prepareItem, roleOf } from "@/lib/feeds/normalize";
import { sanitizeFeedHtml, sanitizeFeedInline } from "@/lib/feeds/sanitize-feed";
import { computeDedupeHash, computeFeedDedupeHash } from "@/lib/jobs/dedupe";

const settings = {
  userAgent: "test-agent/1.0",
  requestTimeoutMs: 5000,
  maxResponseBytes: 100_000,
  maxRedirects: 3,
  concurrency: 2,
  maxItemsPerFeed: 50,
  failureBackoffMinutes: 5,
};

function feedFor(entry: Record<string, unknown>): ResolvedFeed {
  const loaded = parseFeedConfig({ version: "t", settings, feeds: [entry] });
  const feed = loaded.feeds[0];
  if (!feed) throw new Error("no feed");
  return feed;
}

describe("config/job-feeds.json", () => {
  const config = getFeedConfig();

  it("is valid and has the sources you asked for", () => {
    const ids = config.feeds.map((feed) => feed.id);
    expect(ids).toEqual(
      expect.arrayContaining(["jobtech:it", "jobicy", "devglobaljobs", "startup-jobs", "himalayas", "teamtailor:tibber"]),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses https URLs and never points at an internal host", () => {
    for (const feed of config.feeds) {
      expect(feed.url).toMatch(/^https:\/\//);
      expect(() => assertFetchableUrl(feed.url, feed.allowedHosts)).not.toThrow();
    }
  });

  it("expands Teamtailor boards from the {company} placeholder", () => {
    const tibber = config.feeds.find((feed) => feed.id === "teamtailor:tibber");
    expect(tibber).toMatchObject({
      url: "https://tibber.teamtailor.com/jobs.rss",
      company: "Tibber",
      type: "rss",
      name: "Teamtailor – Tibber",
    });
    expect(tibber?.allowedHosts).toEqual(expect.arrayContaining(["tibber.teamtailor.com", "*.teamtailor.com"]));
  });

  it("keeps per-instance query overrides (JobTech)", () => {
    const english = config.feeds.find((feed) => feed.id === "jobtech:english");
    expect(english?.query).toMatchObject({ "occupation-field": "apaJ_2ja_LuF", limit: 100, q: "english" });
  });

  it("ships Dev Global Jobs switched off, with its attribution", () => {
    const dgj = config.feeds.find((feed) => feed.id === "devglobaljobs");
    expect(dgj?.enabled).toBe(false);
    expect(dgj?.attribution).toBe("Powered by Dev Global Jobs");
  });

  it("is rate limited sensibly (Himalayas daily, Jobicy a few times a day)", () => {
    expect(config.feeds.find((feed) => feed.id === "himalayas")?.minIntervalMinutes).toBeGreaterThanOrEqual(1440);
    expect(config.feeds.find((feed) => feed.id === "jobicy")?.minIntervalMinutes).toBeGreaterThanOrEqual(180);
  });
});

describe("feed config validation", () => {
  const base = { id: "x", name: "X", type: "rss", url: "https://example.com/feed.xml" };

  it("rejects http URLs, unknown keys and bad ids", () => {
    expect(() => parseFeedConfig({ version: "t", settings, feeds: [{ ...base, url: "http://example.com/f" }] })).toThrow();
    expect(() => parseFeedConfig({ version: "t", settings, feeds: [{ ...base, surprise: true }] })).toThrow();
    expect(() => parseFeedConfig({ version: "t", settings, feeds: [{ ...base, id: "Bad Id" }] })).toThrow();
  });

  it("rejects a placeholder without instances, a missing variable and duplicate ids", () => {
    const url = "https://{company}.example.com/jobs.rss";
    expect(() => parseFeedConfig({ version: "t", settings, feeds: [{ ...base, url }] })).toThrow(FeedConfigError);
    expect(() =>
      parseFeedConfig({ version: "t", settings, feeds: [{ ...base, url, instances: [{ id: "a", vars: {} }] }] }),
    ).toThrow(/does not define it/);
    expect(() => parseFeedConfig({ version: "t", settings, feeds: [base, base] })).toThrow(/Duplicate feed id/);
  });

  it("URL-encodes instance variables", () => {
    const feed = feedFor({ ...base, url: "https://example.com/{board}/jobs", instances: [{ id: "a", vars: { board: "a.b-c" } }] });
    expect(feed.url).toBe("https://example.com/a.b-c/jobs");
  });

  it("ignores _comment keys", () => {
    expect(() => parseFeedConfig({ _readme: "hi", version: "t", settings, feeds: [{ ...base, _note: "x" }] })).not.toThrow();
  });
});

describe("REST JSON adapter", () => {
  const jobtech = getFeedConfig().feeds.find((feed) => feed.id === "jobtech:it") as ResolvedFeed;
  const jobicy = getFeedConfig().feeds.find((feed) => feed.id === "jobicy") as ResolvedFeed;

  it("maps a JobTech-shaped response", () => {
    const body = JSON.stringify({
      total: { value: 2 },
      hits: [
        {
          id: "123",
          headline: "Backend Developer",
          employer: { name: "Acme AB" },
          webpage_url: "https://arbetsformedlingen.se/platsbanken/annonser/123",
          application_details: { url: "https://acme.example/apply" },
          description: { text: "Plain text", text_formatted: "<p>Formatted</p>" },
          workplace_address: { municipality: "Stockholm", country: "Sverige" },
          publication_date: "2026-11-05T08:00:00",
        },
        { id: "124", employer: { name: "No Title" } },
      ],
    });
    const parsed = parseFeedBody(jobtech, body, 50);
    expect(parsed.total).toBe(2);
    expect(parsed.malformed).toBe(1);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      externalId: "123",
      title: "Backend Developer",
      company: "Acme AB",
      url: "https://arbetsformedlingen.se/platsbanken/annonser/123",
      applyUrl: "https://acme.example/apply",
      description: "<p>Formatted</p>",
      location: "Stockholm",
      country: "Sverige",
    });
    expect(parsed.items[0]?.postedAt).toBeInstanceOf(Date);
  });

  it("maps a Jobicy-shaped response, including salary", () => {
    const body = JSON.stringify({
      apiVersion: "v2",
      jobs: [
        {
          id: 77,
          url: "https://jobicy.com/jobs/77-python-dev",
          jobTitle: "Python Developer",
          companyName: "Globex",
          jobType: ["Full-Time"],
          jobGeo: "Europe",
          jobDescription: "<p>Build things</p>",
          pubDate: "2026-11-04 10:00:00",
          salaryMin: 60000,
          salaryMax: 80000,
          salaryCurrency: "EUR",
          salaryPeriod: "yearly",
        },
      ],
    });
    const [item] = parseFeedBody(jobicy, body, 50).items;
    expect(item).toMatchObject({
      externalId: "77",
      title: "Python Developer",
      company: "Globex",
      employmentTypeText: "Full-Time",
      salaryMin: 60000,
      salaryMax: 80000,
      salaryCurrency: "EUR",
    });
  });

  it("caps the number of items but reports the total", () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({ id: i, headline: `Job ${i}`, employer: { name: "A" } }));
    const parsed = parseFeedBody(jobtech, JSON.stringify({ hits }), 3);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.total).toBe(10);
  });

  it("accepts a top-level array (Lever style)", () => {
    const feed = feedFor({
      id: "lv",
      name: "Lever",
      type: "rest-json",
      url: "https://api.lever.co/v0/postings/x",
      itemsPath: "",
      defaults: { company: "Lever Demo" },
      fields: { title: "text", url: "hostedUrl", postedAt: "createdAt", location: "categories.location" },
    });
    const body = JSON.stringify([{ text: "Engineer", hostedUrl: "https://jobs.lever.co/x/1", createdAt: 1730000000000, categories: { location: "Oslo" } }]);
    const [item] = parseFeedBody(feed, body, 10).items;
    expect(item).toMatchObject({ title: "Engineer", company: "Lever Demo", location: "Oslo" });
    expect(item?.postedAt?.getUTCFullYear()).toBe(2024);
  });

  it("explains what is wrong when the response does not look right", () => {
    expect(() => parseFeedBody(jobtech, "<html>oops</html>", 10)).toThrow(/not valid JSON/);
    expect(() => parseFeedBody(jobtech, JSON.stringify({ results: [] }), 10)).toThrow(/itemsPath/);
    expect(() => parseFeedBody(jobtech, JSON.stringify({ hits: [] }), 10)).not.toThrow();
    expect(() => parseFeedBody(jobtech, "oops", 10)).toThrow(FeedParseError);
  });
});

describe("RSS / Atom adapter", () => {
  const startup = getFeedConfig().feeds.find((feed) => feed.id === "startup-jobs") as ResolvedFeed;
  const himalayas = getFeedConfig().feeds.find((feed) => feed.id === "himalayas") as ResolvedFeed;
  const teamtailor = getFeedConfig().feeds.find((feed) => feed.id === "teamtailor:tibber") as ResolvedFeed;

  it("splits 'Role at Company' titles on the last ' at ' (Startup Jobs)", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Startup Jobs</title>
      <item><title>Staff Engineer at Scale at Acme Corp</title>
      <link>https://startup.jobs/staff-engineer-1?utm_source=rss&amp;utm_medium=feed</link>
      <guid isPermaLink="true">https://startup.jobs/staff-engineer-1</guid>
      <pubDate>Fri, 06 Nov 2026 22:53:42 +0000</pubDate>
      <description>Build and ship. Remote, New York, U.S.</description></item>
      <item><title>No separator here</title><link>https://startup.jobs/x</link></item></channel></rss>`;
    const parsed = parseFeedBody(startup, xml, 50);
    expect(parsed.items[0]).toMatchObject({ title: "Staff Engineer at Scale", company: "Acme Corp" });
    // A title without ' at ' has no company, which prepareItem later rejects
    expect(parsed.items[1]?.company).toBeUndefined();
    expect(parsed.items[0]?.url).toBe("https://startup.jobs/staff-engineer-1");
    expect(parsed.items[0]?.postedAt?.toISOString()).toBe("2026-11-06T22:53:42.000Z");
  });

  it("reads namespaced fields and survives a duplicate <guid> (Himalayas)", () => {
    const xml = `<rss version="2.0" xmlns:himalayasJobs="https://himalayas.app/ns" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
      <item><title>Enterprise Account Executive</title>
      <description>short</description>
      <link>https://himalayas.app/companies/spinwheel/jobs/enterprise-account-executive</link>
      <guid isPermaLink="true">https://himalayas.app/companies/spinwheel/jobs/enterprise-account-executive</guid>
      <guid>https://himalayas.app/companies/spinwheel/jobs/enterprise-account-executive</guid>
      <category>Sales</category><category>B2B</category>
      <himalayasJobs:companyName>Spinwheel</himalayasJobs:companyName>
      <himalayasJobs:locationRestriction>United States</himalayasJobs:locationRestriction>
      <content:encoded><![CDATA[<p>Full <b>body</b></p><p>Originally posted on Himalayas</p>]]></content:encoded>
      </item></channel></rss>`;
    const [item] = parseFeedBody(himalayas, xml, 10).items;
    expect(item).toMatchObject({
      company: "Spinwheel",
      location: "United States",
      url: "https://himalayas.app/companies/spinwheel/jobs/enterprise-account-executive",
      externalId: "https://himalayas.app/companies/spinwheel/jobs/enterprise-account-executive",
    });
    expect(item?.description).toContain("Originally posted on Himalayas");
  });

  it("reads a Teamtailor item and takes the employer from the instance", () => {
    const xml = `<rss version="2.0" xmlns:tt="http://www.teamtailor.com/rss"><channel><title>Tibber</title>
      <item><guid>https://tibber.teamtailor.com/jobs/1-backend</guid><pubDate>Mon, 03 Nov 2026 09:00:00 +0000</pubDate>
      <title>Backend Engineer</title><description><![CDATA[<p>Work with us</p>]]></description>
      <link>https://tibber.teamtailor.com/jobs/1-backend</link><remoteStatus>hybrid</remoteStatus>
      <tt:department>Engineering</tt:department>
      <tt:locations><tt:location><tt:name>Stockholm HQ</tt:name><tt:city>Stockholm</tt:city><tt:country>Sweden</tt:country></tt:location></tt:locations>
      </item></channel></rss>`;
    const [item] = parseFeedBody(teamtailor, xml, 10).items;
    expect(item).toMatchObject({ company: "Tibber", location: "Stockholm", country: "Sweden", workModeText: "hybrid" });
  });

  it("reads Atom feeds with sensible defaults", () => {
    const feed = feedFor({ id: "atom", name: "Atom", type: "rss", url: "https://example.com/atom", defaults: { company: "Example" } });
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Jobs</title>
      <entry><title>Data Engineer</title><id>urn:job:9</id>
      <link rel="alternate" href="https://example.com/jobs/9"/>
      <published>2026-11-01T10:00:00Z</published><content type="html">&lt;p&gt;Pipelines&lt;/p&gt;</content></entry></feed>`;
    const [item] = parseFeedBody(feed, xml, 10).items;
    expect(item).toMatchObject({ title: "Data Engineer", url: "https://example.com/jobs/9", externalId: "urn:job:9", company: "Example" });
    expect(item?.description).toBe("<p>Pipelines</p>");
  });

  it("reports unusable bodies in plain words", () => {
    expect(() => parseFeedBody(startup, "<html><body>Not a feed</body></html>", 10)).toThrow(/Expected an RSS or Atom feed/);
    expect(() => parseFeedBody(startup, "<rss><channel>", 10)).toThrow(/not valid XML/);
    expect(() => parseFeedBody(startup, '<!DOCTYPE x [<!ENTITY a "b">]><rss/>', 10)).toThrow(FeedParseError);
  });
});

describe("path lookup and dates", () => {
  it("never reads prototype keys", () => {
    expect(readPath({ a: 1 }, "__proto__")).toEqual([]);
    expect(readPath({ a: {} }, "a.constructor")).toEqual([]);
    expect(readPath(JSON.parse('{"__proto__": {"x": "polluted"}}'), "__proto__.x")).toEqual([]);
  });

  it("flattens arrays along the path", () => {
    expect(readPath({ a: [{ b: 1 }, { b: 2 }] }, "a.b")).toEqual([1, 2]);
  });

  it("parses epoch seconds and milliseconds, ISO and RFC 822, and rejects nonsense", () => {
    expect(parseFeedDate("1730000000")?.getUTCFullYear()).toBe(2024);
    expect(parseFeedDate("1730000000000")?.getUTCFullYear()).toBe(2024);
    expect(parseFeedDate("2026-11-05T08:00:00Z")?.toISOString()).toBe("2026-11-05T08:00:00.000Z");
    expect(parseFeedDate("Fri, 06 Nov 2026 22:53:42 +0000")?.toISOString()).toBe("2026-11-06T22:53:42.000Z");
    expect(parseFeedDate("yesterday")).toBeUndefined();
    expect(parseFeedDate("0001-01-01")).toBeUndefined();
    expect(parseFeedDate(undefined)).toBeUndefined();
  });
});

describe("safe fetching", () => {
  const options = {
    userAgent: "t/1",
    timeoutMs: 1000,
    maxBytes: 1000,
    maxRedirects: 2,
    allowedHosts: ["feeds.example.com", "*.teamtailor.com"],
    accept: "*/*",
  };

  it.each([
    "http://feeds.example.com/x",
    "https://user:pw@feeds.example.com/x",
    "https://feeds.example.com:8443/x",
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://localhost/x",
    "https://printer.local/x",
    "https://evil.example.org/x",
    "https://teamtailor.com.evil.org/x",
    "file:///etc/passwd",
    "not a url",
  ])("blocks %s", (url) => {
    expect(() => assertFetchableUrl(url, options.allowedHosts)).toThrow(FeedFetchError);
  });

  it("allows the listed host and wildcard subdomains", () => {
    expect(() => assertFetchableUrl("https://feeds.example.com/a", options.allowedHosts)).not.toThrow();
    expect(() => assertFetchableUrl("https://tibber.teamtailor.com/jobs.rss", options.allowedHosts)).not.toThrow();
    expect(() => assertFetchableUrl("https://teamtailor.com/x", options.allowedHosts)).toThrow();
  });

  it("returns the body and sends our user agent", async () => {
    let seen: RequestInit | undefined;
    const text = await fetchFeedText("https://feeds.example.com/a", {
      ...options,
      fetchImpl: async (_url, init) => {
        seen = init;
        return new Response("hello");
      },
    });
    expect(text).toBe("hello");
    expect((seen?.headers as Record<string, string>)["user-agent"]).toBe("t/1");
    expect(seen?.redirect).toBe("manual");
  });

  it("follows redirects only to allowed hosts", async () => {
    const calls: string[] = [];
    const impl = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/a")) return new Response(null, { status: 301, headers: { location: "https://tibber.teamtailor.com/b" } });
      return new Response("ok");
    };
    expect(await fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: impl })).toBe("ok");
    expect(calls).toEqual(["https://feeds.example.com/a", "https://tibber.teamtailor.com/b"]);

    const evil = async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } });
    await expect(fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: evil })).rejects.toMatchObject({
      code: "blocked_url",
    });
    const downgrade = async () => new Response(null, { status: 302, headers: { location: "http://feeds.example.com/" } });
    await expect(fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: downgrade })).rejects.toMatchObject({
      code: "blocked_url",
    });
  });

  it("gives up after too many redirects", async () => {
    const loop = async () => new Response(null, { status: 302, headers: { location: "https://feeds.example.com/a" } });
    await expect(fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: loop })).rejects.toMatchObject({
      code: "too_many_redirects",
    });
  });

  it("reports HTTP errors, timeouts and network failures without leaking internals", async () => {
    await expect(
      fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: async () => new Response("no", { status: 503 }) }),
    ).rejects.toMatchObject({ code: "http_status", message: "feeds.example.com answered HTTP 503." });

    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    await expect(
      fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: async () => Promise.reject(timeout) }),
    ).rejects.toMatchObject({ code: "timeout" });

    await expect(
      fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: async () => Promise.reject(new TypeError("ECONNRESET 10.0.0.5")) }),
    ).rejects.toMatchObject({ code: "network", message: "Could not reach feeds.example.com." });
  });

  it("enforces the size cap from the header and while streaming", async () => {
    const declared = async () => new Response("x", { headers: { "content-length": "999999" } });
    await expect(fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: declared })).rejects.toMatchObject({ code: "too_large" });

    const streamed = async () => new Response("y".repeat(5000));
    await expect(fetchFeedText("https://feeds.example.com/a", { ...options, fetchImpl: streamed })).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("sanitising feed content", () => {
  it("removes scripts, tracking pixels, links, styles and event handlers, keeping the text", () => {
    const html =
      '<p onclick="steal()">Hello <b>world</b></p><script>alert(1)</script><style>p{color:red}</style>' +
      '<img src="https://tracker.example/pixel.gif" width="1" height="1" onerror="x()">' +
      '<a href="javascript:alert(2)">Apply here</a><iframe src="https://evil.example"></iframe>' +
      "<ul><li>One</li><li>Two</li></ul>";
    const text = sanitizeFeedHtml(html);
    expect(text).toBe("Hello world\nApply here\n\n- One\n- Two");
    expect(text).not.toMatch(/alert|steal|tracker|pixel|javascript|iframe|color:red|</i);
  });

  it("handles entity-escaped HTML (Greenhouse style) by treating it as markup", () => {
    const text = sanitizeFeedHtml("&lt;p&gt;We build&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;ul&gt;&lt;li&gt;APIs&lt;/li&gt;&lt;/ul&gt;");
    expect(text).toBe("We build\n\n- APIs");
  });

  it("keeps ampersands and angle-bracket text readable", () => {
    expect(sanitizeFeedHtml("<p>R&amp;D at 5 &lt; 6 teams</p>")).toBe("R&D at 5 < 6 teams");
  });

  it("flattens titles and locations to one clean line", () => {
    expect(sanitizeFeedInline('<b>Senior</b> Engineer<script>x()</script>\n(Remote)')).toBe("Senior Engineer (Remote)");
  });
});

describe("normalising items", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const feed = feedFor({
    id: "t",
    name: "Test Feed",
    type: "rest-json",
    url: "https://example.com/api",
    attribution: "Jobs via Test Feed",
    defaults: { workMode: "REMOTE" },
    fields: {},
  });
  const raw = {
    title: "Senior <b>Backend</b> Engineer",
    company: "Acme",
    url: "https://example.com/jobs/1?utm_source=x&b=2&a=1#top",
    description:
      "<p>You will build APIs with TypeScript, Node.js and PostgreSQL.</p><p>Requirements:</p><ul><li>5+ years of experience</li></ul>",
    salaryMin: 60000,
    salaryMax: 80000,
    salaryCurrency: "eur",
    salaryPeriod: "yearly",
  };

  it("canonicalises links so tracking parameters and ordering do not matter", () => {
    expect(canonicalizeUrl("https://example.com/jobs/1/?utm_source=x&b=2&a=1#top")).toBe("https://example.com/jobs/1?a=1&b=2");
    expect(canonicalizeUrl("javascript:alert(1)")).toBeUndefined();
    expect(canonicalizeUrl("https://u:p@example.com/")).toBeUndefined();
    expect(canonicalizeUrl(undefined)).toBeUndefined();
  });

  it("builds a validated job with skills, attribution and the source link", () => {
    const prepared = prepareItem(raw, now);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.item.title).toBe("Senior Backend Engineer");
    expect(prepared.item.externalUrl).toBe("https://example.com/jobs/1?a=1&b=2");

    const role = roleOf(prepared.item);
    expect(role).toBe("SOFTWARE_ENGINEER");
    const job = buildFeedJob(prepared.item, role!, feed);
    expect(job).toMatchObject({
      sourceName: "Test Feed",
      sourceUrl: "https://example.com/jobs/1?a=1&b=2",
      applyUrl: "https://example.com/jobs/1?a=1&b=2",
      attribution: "Jobs via Test Feed",
      workMode: "REMOTE",
      seniority: "SENIOR",
      salaryMin: 60000,
      salaryMax: 80000,
      salaryCurrency: "EUR",
    });
    expect(job.skills).toEqual(expect.arrayContaining(["TypeScript", "Node.js", "PostgreSQL"]));
    expect(job.requirements).toContain("5+ years of experience");
  });

  it("drops hourly pay, converts monthly pay and ignores salaries without a currency", () => {
    const build = (extra: Record<string, unknown>) => {
      const prepared = prepareItem({ ...raw, ...extra } as RawFeedItem, now);
      if (!prepared.ok) throw new Error(prepared.reason);
      return buildFeedJob(prepared.item, "SOFTWARE_ENGINEER", feed);
    };
    expect(build({ salaryPeriod: "hourly" }).salaryMin).toBeUndefined();
    expect(build({ salaryPeriod: "monthly", salaryMin: 5000, salaryMax: 6000 })).toMatchObject({ salaryMin: 60000, salaryMax: 72000 });
    expect(build({ salaryCurrency: undefined }).salaryMin).toBeUndefined();
    expect(build({ salaryMin: 90000, salaryMax: 10000 }).salaryMin).toBeUndefined();
  });

  const unusable: Array<[string, Record<string, unknown>, string]> = [
    ["no title", { title: "  " }, "missing title"],
    ["no company", { company: undefined }, "missing company"],
    ["no usable link", { url: "javascript:alert(1)", applyUrl: undefined }, "missing or unusable link"],
    ["nothing but markup in the description", { description: "<script>x()</script><img src=x>" }, "empty description"],
  ];
  it.each(unusable)("rejects an item with %s", (_label, change, reason) => {
    expect(prepareItem({ ...raw, ...change } as RawFeedItem, now)).toEqual({ ok: false, reason });
  });

  it("never lets a future date pin a job to the top of the board", () => {
    const prepared = prepareItem({ ...raw, postedAt: new Date("2030-01-01T00:00:00Z") }, now);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.item.postedAt).toEqual(now);
  });

  it("treats non-matching roles as out of scope", () => {
    const prepared = prepareItem({ ...raw, title: "Regional Sales Manager" }, now);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(roleOf(prepared.item)).toBeUndefined();
  });

  it("uses a feed's work-mode hint before guessing", () => {
    const hinted = feedFor({ id: "h", name: "H", type: "rest-json", url: "https://example.com/api", fields: {} });
    const prepared = prepareItem({ ...raw, workModeText: "hybrid" }, now);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(buildFeedJob(prepared.item, "SOFTWARE_ENGINEER", hinted).workMode).toBe("HYBRID");
  });
});

describe("feed fingerprints", () => {
  const base = { company: "Acme AB", title: "Backend Engineer", externalUrl: "https://example.com/jobs/1" };

  it("is stable across case, spacing and a trailing slash", () => {
    expect(computeFeedDedupeHash(base)).toBe(
      computeFeedDedupeHash({ company: " ACME  ab ", title: "backend   engineer", externalUrl: "https://EXAMPLE.com/jobs/1/" }),
    );
  });

  it("changes with company, title or link, and never equals a manual-job hash", () => {
    const hash = computeFeedDedupeHash(base);
    expect(hash).not.toBe(computeFeedDedupeHash({ ...base, company: "Other" }));
    expect(hash).not.toBe(computeFeedDedupeHash({ ...base, title: "Frontend Engineer" }));
    expect(hash).not.toBe(computeFeedDedupeHash({ ...base, externalUrl: "https://example.com/jobs/2" }));
    expect(hash).not.toBe(computeDedupeHash({ company: base.company, title: base.title }));
  });
});

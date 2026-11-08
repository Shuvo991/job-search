import { describe, expect, it } from "vitest";
import { parseFeedBody } from "@/lib/feeds/adapters";
import { getFeedConfig, type ResolvedFeed } from "@/lib/feeds/config";
import { buildFeedJob, prepareItem, roleOf } from "@/lib/feeds/normalize";

/**
 * The extra sources in config/job-feeds.json. The sample bodies follow each source's published
 * response format (they are not live captures), so these tests pin the field mapping; the first real
 * sync is what confirms the live APIs still look like this.
 */

const feeds = getFeedConfig().feeds;
function feed(id: string): ResolvedFeed {
  const found = feeds.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`feed ${id} missing from config/job-feeds.json`);
  return found;
}

const NOW = new Date("2026-11-08T12:00:00Z");
const BODY =
  "<p>We are looking for a backend engineer to build services in Python and PostgreSQL. You will work with a friendly team on APIs and cloud infrastructure.</p>";

function importable(feedId: string, body: unknown) {
  const resolved = feed(feedId);
  const parsed = parseFeedBody(resolved, JSON.stringify(body), 50);
  const first = parsed.items[0];
  if (!first) throw new Error("nothing parsed");
  const prepared = prepareItem(first, NOW);
  if (!prepared.ok) throw new Error(prepared.reason);
  const role = roleOf(prepared.item);
  if (!role) throw new Error("no role");
  return { parsed, first, job: buildFeedJob(prepared.item, role, resolved) };
}

describe("the extra sources are configured", () => {
  const ids = feeds.map((candidate) => candidate.id);

  it("includes every added source", () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        "arbeitnow",
        "arbeitnow-uk",
        "remotive:software-dev",
        "remotive:product",
        "remoteok",
        "workingnomads",
        "lever:spotify",
        "lever:einride",
        "ashby:lovable",
      ]),
    );
  });

  it("keeps Remotive within its 4 fetches a day", () => {
    const remotive = feeds.filter((candidate) => candidate.id.startsWith("remotive:"));
    const perDay = remotive.reduce((sum, candidate) => sum + 1440 / candidate.minIntervalMinutes, 0);
    expect(perDay).toBeLessThanOrEqual(4);
  });

  it("sends Remote OK its own User-Agent and leaves the others on the default", () => {
    expect(feed("remoteok").userAgent).toMatch(/job-search-local/);
    expect(feed("arbeitnow").userAgent).toBeUndefined();
  });

  it("credits every new source", () => {
    for (const id of ["arbeitnow", "remotive:product", "remoteok", "workingnomads", "lever:spotify", "ashby:lovable"]) {
      expect(feed(id).attribution ?? "").not.toBe("");
    }
  });
});

describe("Arbeitnow", () => {
  const body = {
    data: [
      {
        slug: "backend-engineer-acme-berlin-123",
        company_name: "Acme GmbH",
        title: "Backend Engineer (Python)",
        description: BODY,
        remote: true,
        url: "https://www.arbeitnow.com/jobs/companies/acme/backend-engineer-acme-berlin-123",
        tags: ["Engineering"],
        job_types: ["full_time"],
        location: "Berlin",
        created_at: 1794000000,
      },
    ],
    links: { next: null },
    meta: { current_page: 1 },
  };

  it("maps the response, reading remote:true, a unix date and full_time", () => {
    const { first, job } = importable("arbeitnow", body);
    expect(first).toMatchObject({ title: "Backend Engineer (Python)", company: "Acme GmbH", location: "Berlin" });
    expect(first.postedAt?.toISOString()).toBe("2026-11-06T21:20:00.000Z");
    expect(job).toMatchObject({ workMode: "REMOTE", employmentType: "FULL_TIME", sourceName: "Arbeitnow" });
    expect(job.skills).toEqual(expect.arrayContaining(["Python"]));
  });

  it("does not force on-site when remote is false", () => {
    const { job } = importable("arbeitnow", { data: [{ ...body.data[0], remote: false }] });
    expect(job.workMode).not.toBe("ONSITE");
  });
});

describe("Remotive", () => {
  it("maps the response and treats the jobs as remote", () => {
    const { first, job } = importable("remotive:software-dev", {
      "0-legal-notice": "Remotive attribution notice",
      "job-count": 1,
      jobs: [
        {
          id: 2077702,
          url: "https://remotive.com/remote-jobs/software-development/senior-python-engineer-2077702",
          title: "Senior Python Engineer",
          company_name: "TechCorp",
          category: "Software Development",
          tags: ["python"],
          job_type: "full_time",
          publication_date: "2026-11-07T09:30:00",
          candidate_required_location: "Europe",
          description: BODY,
        },
      ],
    });
    expect(first).toMatchObject({ company: "TechCorp", location: "Europe", externalId: "2077702" });
    expect(job).toMatchObject({ workMode: "REMOTE", employmentType: "FULL_TIME" });
  });
});

describe("Remote OK", () => {
  const body = [
    { last_updated: 1794000000, legal: "API Terms of Service: link back to Remote OK" },
    {
      id: "1000001",
      epoch: 1794000000,
      date: "2026-11-07T10:00:00+00:00",
      company: "Example Co",
      position: "Senior Backend Engineer",
      tags: ["python"],
      description: BODY,
      location: "Worldwide",
      apply_url: "https://remoteok.com/remote-jobs/1000001",
      url: "https://remoteok.com/remote-jobs/remote-senior-backend-engineer-example-co-1000001",
    },
  ];

  it("skips the legal-notice element and imports the jobs", () => {
    const resolved = feed("remoteok");
    const parsed = parseFeedBody(resolved, JSON.stringify(body), 50);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.malformed).toBe(1);
    expect(parsed.items[0]).toMatchObject({ title: "Senior Backend Engineer", company: "Example Co" });
  });

  it("keeps the Remote OK page as the job link", () => {
    const { job } = importable("remoteok", body);
    expect(job.sourceUrl).toBe("https://remoteok.com/remote-jobs/remote-senior-backend-engineer-example-co-1000001");
    expect(job.workMode).toBe("REMOTE");
  });
});

describe("Working Nomads", () => {
  it("maps a list of exposed jobs", () => {
    const { first, job } = importable("workingnomads", [
      {
        url: "https://www.workingnomads.com/jobs/senior-python-engineer-acme",
        title: "Senior Python Engineer",
        description: BODY,
        company_name: "Acme",
        category_name: "Development",
        tags: "python,backend",
        location: "Europe",
        pub_date: "2026-11-06T08:00:00-05:00",
      },
    ]);
    expect(first).toMatchObject({ company: "Acme", location: "Europe" });
    expect(job.workMode).toBe("REMOTE");
  });
});

describe("Lever and Ashby company boards", () => {
  it("maps a Lever posting (millisecond date, workplaceType)", () => {
    const { first, job } = importable("lever:spotify", [
      {
        id: "abc-123",
        text: "Backend Engineer, Payments",
        hostedUrl: "https://jobs.lever.co/spotify/abc-123",
        applyUrl: "https://jobs.lever.co/spotify/abc-123/apply",
        descriptionPlain: "We are looking for a backend engineer to build services in Python and PostgreSQL on cloud infrastructure.",
        categories: { location: "Stockholm", commitment: "Full-time", team: "Payments" },
        workplaceType: "hybrid",
        createdAt: 1794000000000,
      },
    ]);
    expect(first.company).toBe("Spotify");
    expect(first.postedAt?.toISOString()).toBe("2026-11-06T21:20:00.000Z");
    expect(job).toMatchObject({ workMode: "HYBRID", employmentType: "FULL_TIME", location: "Stockholm" });
  });

  it("maps an Ashby posting (workplaceType and FullTime)", () => {
    const { first, job } = importable("ashby:lovable", {
      jobs: [
        {
          id: "9f2c",
          title: "Product Manager",
          location: "Stockholm",
          employmentType: "FullTime",
          workplaceType: "OnSite",
          isRemote: false,
          publishedAt: "2026-11-01T09:00:00.000+00:00",
          jobUrl: "https://jobs.ashbyhq.com/lovable/9f2c",
          applyUrl: "https://jobs.ashbyhq.com/lovable/9f2c/application",
          descriptionHtml:
            "<p>Own the roadmap for our product. You will work with engineers and designers, talk to users and decide what to build next.</p>",
        },
      ],
    });
    expect(first.company).toBe("Lovable");
    expect(job).toMatchObject({ workMode: "ONSITE", employmentType: "FULL_TIME", roleCategory: "PRODUCT_MANAGER" });
  });
});

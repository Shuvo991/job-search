import { describe, expect, it } from "vitest";
import { computeDedupeHash } from "@/lib/jobs/dedupe";
import { descriptionToBlocks, formatPlace, formatPosted, formatSalary, safeHref } from "@/lib/jobs/format";
import {
  buildQueryString,
  parseJobsSearchParams,
  parseJobsSearchParamsLeniently,
} from "@/lib/jobs/search-params";
import { buildJobFromRequest } from "@/lib/jobs/build-job";
import { SEED_JOBS } from "../../prisma/seed-data";

describe("computeDedupeHash", () => {
  it("ignores case, punctuation, spacing and accents", () => {
    const a = computeDedupeHash({ company: "Pixelhaven Studios", title: "Gameplay Programmer (Unity)", location: "Malmö" });
    const b = computeDedupeHash({ company: "  PIXELHAVEN  studios ", title: "gameplay programmer - unity", location: "Malmo" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes different locations and companies", () => {
    const base = { company: "Acme", title: "Engineer", location: "Oslo" };
    expect(computeDedupeHash(base)).not.toBe(computeDedupeHash({ ...base, location: "Bergen" }));
    expect(computeDedupeHash(base)).not.toBe(computeDedupeHash({ ...base, company: "Acme 2" }));
    expect(computeDedupeHash({ ...base, location: null })).toBe(computeDedupeHash({ company: "Acme", title: "Engineer" }));
  });
});

describe("search params", () => {
  it("parses filters, repeated and comma-separated skills, and applies the default page size", () => {
    const query = parseJobsSearchParams(
      new URLSearchParams("q=react+node&roleCategory=SOFTWARE_ENGINEER&skill=SQL&skill=Docker,Kafka&page=2"),
    );
    expect(query).toMatchObject({
      q: "react node",
      roleCategory: "SOFTWARE_ENGINEER",
      skills: ["SQL", "Docker", "Kafka"],
      page: 2,
      pageSize: 25,
    });
  });

  it("ignores empty fields from an untouched HTML form", () => {
    const query = parseJobsSearchParams(new URLSearchParams("q=&roleCategory=&workMode=&seniority=&location=&sector="));
    expect(query).toMatchObject({ skills: [], page: 1 });
    expect(query.q).toBeUndefined();
    expect(query.roleCategory).toBeUndefined();
  });

  it("accepts Next.js searchParams objects", () => {
    const query = parseJobsSearchParams({ skill: ["A", "B"], q: "x", ignored: undefined });
    expect(query.skills).toEqual(["A", "B"]);
  });

  it("is strict for the API but lenient for the page", () => {
    expect(() => parseJobsSearchParams(new URLSearchParams("roleCategory=NOPE"))).toThrow();
    const lenient = parseJobsSearchParamsLeniently(new URLSearchParams("roleCategory=NOPE&q=ok&page=abc&pageSize=9999"));
    expect(lenient).toMatchObject({ q: "ok", page: 1, pageSize: 10 });
    expect(lenient.roleCategory).toBeUndefined();
  });

  it("round-trips filters into links", () => {
    const query = parseJobsSearchParams(new URLSearchParams("q=a+b&skill=SQL&skill=Docker&page=3&workMode=REMOTE"));
    const text = buildQueryString(query);
    expect(parseJobsSearchParams(new URLSearchParams(text.slice(1)))).toMatchObject({
      q: "a b",
      skills: ["SQL", "Docker"],
      page: 3,
      workMode: "REMOTE",
    });
    expect(buildQueryString(query, { page: 1, skills: ["SQL"] })).toBe("?q=a+b&workMode=REMOTE&skill=SQL");
    expect(buildQueryString({ skills: [], page: 1 })).toBe("");
  });
});

describe("format helpers", () => {
  it("formats salaries", () => {
    expect(formatSalary({ salaryMin: 780000, salaryMax: 1020000, salaryCurrency: "SEK" })).toBe("SEK 780,000 – 1,020,000 / year");
    expect(formatSalary({ salaryMin: 50000, salaryMax: null, salaryCurrency: "EUR" })).toBe("From EUR 50,000 / year");
    expect(formatSalary({ salaryMin: null, salaryMax: 90000, salaryCurrency: null })).toBe("Up to 90,000 / year");
    expect(formatSalary({ salaryMin: null, salaryMax: null, salaryCurrency: "EUR" })).toBeNull();
  });

  it("formats posted dates relative to now", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(formatPosted(new Date("2026-11-07T08:00:00Z"), now)).toBe("Posted today");
    expect(formatPosted(new Date("2026-11-06T08:00:00Z"), now)).toBe("Posted yesterday");
    expect(formatPosted(new Date("2026-11-02T12:00:00Z"), now)).toBe("Posted 5 days ago");
    expect(formatPosted(new Date("2026-08-01T12:00:00Z"), now)).toBe("Posted 1 Aug 2026");
    expect(formatPosted(null, now)).toBeNull();
  });

  it("joins location and country without repeating the country", () => {
    expect(formatPlace("Stockholm", "Sweden")).toBe("Stockholm, Sweden");
    expect(formatPlace("Stockholm, Sweden", "Sweden")).toBe("Stockholm, Sweden");
    expect(formatPlace(null, "Sweden")).toBe("Sweden");
    expect(formatPlace(null, null)).toBeNull();
  });

  it("only turns http(s) links into hrefs", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
  });

  it("splits a description into headings, paragraphs and lists", () => {
    const blocks = descriptionToBlocks("Intro line one\nline two\n\nRequirements:\n- A\n- B\n\nClosing words");
    expect(blocks).toEqual([
      { type: "paragraph", text: "Intro line one line two" },
      { type: "heading", text: "Requirements" },
      { type: "list", items: ["A", "B"] },
      { type: "paragraph", text: "Closing words" },
    ]);
  });
});

describe("seed data", () => {
  const built = SEED_JOBS.map(({ request, daysAgo }) => ({
    job: buildJobFromRequest(request, new Date(Date.UTC(2026, 10, 7) - daysAgo * 86_400_000)),
    daysAgo,
  }));

  it("contains exactly five jobs that pass the same validation as the Add Job form", () => {
    expect(SEED_JOBS).toHaveLength(5);
    expect(built).toHaveLength(5);
  });

  it("has unique fingerprints, so re-seeding never duplicates", () => {
    const hashes = new Set(built.map(({ job }) => computeDedupeHash(job)));
    expect(hashes.size).toBe(5);
  });

  it("gives every filter something to select: five roles, three work modes, two sectors, several places", () => {
    const jobs = built.map(({ job }) => job);
    expect(new Set(jobs.map((job) => job.roleCategory)).size).toBe(5);
    expect(new Set(jobs.map((job) => job.workMode))).toEqual(new Set(["HYBRID", "REMOTE", "ONSITE"]));
    expect(new Set(jobs.map((job) => job.sector))).toEqual(new Set(["TECH", "GAMING"]));
    expect(new Set(jobs.map((job) => job.location)).size).toBe(5);
  });

  it("auto-detects sensible skills for each job", () => {
    const skillsByTitle = Object.fromEntries(built.map(({ job }) => [job.title, job.skills]));
    expect(skillsByTitle["Senior Backend Engineer"]).toEqual(
      expect.arrayContaining(["TypeScript", "Node.js", "AWS", "PostgreSQL", "Docker", "Kubernetes", "Apache Kafka", "Jest", "Communication", "Mentoring"]),
    );
    expect(skillsByTitle["Technical Product Manager, Developer Platform"]).toEqual(
      expect.arrayContaining(["Product Roadmap", "SQL", "A/B Testing", "OKRs", "Jira", "Scrum", "Stakeholder Management"]),
    );
    expect(skillsByTitle["Gameplay Programmer (Unity)"]).toEqual(
      expect.arrayContaining(["Unity", "C#", "Multiplayer Networking", "Perforce", "Shader Programming", "Live Operations"]),
    );
    expect(skillsByTitle["Senior Data Engineer"]).toEqual(
      expect.arrayContaining(["Python", "SQL", "Apache Airflow", "Snowflake", "dbt", "Apache Kafka", "Apache Spark", "Terraform", "AWS"]),
    );
    expect(skillsByTitle["AI Engineer, LLM Applications"]).toEqual(
      expect.arrayContaining(["Python", "RAG", "FastAPI", "Vector Databases", "Docker", "Ollama", "Hugging Face", "PyTorch", "PostgreSQL"]),
    );
  });

  it("extracts requirement bullets and never contains markup", () => {
    for (const { job } of built) {
      expect(job.requirements.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(job)).not.toMatch(/<\/?[a-z]/i);
      expect(job.applyUrl).toMatch(/^https:\/\/example\.com\//);
    }
  });

  it("does not detect spurious Go / R / C / Spring in any seed description", () => {
    for (const { job } of built) {
      for (const bogus of ["Go", "R", "C", "Spring Boot", "REST APIs"]) {
        // REST APIs is legitimate only where the text says "REST".
        if (bogus === "REST APIs") continue;
        expect(job.skills, `${job.title} should not contain ${bogus}`).not.toContain(bogus);
      }
    }
  });
});

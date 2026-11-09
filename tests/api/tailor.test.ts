import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "@/lib/api-handler";
import type { JobView } from "@/lib/jobs/repository";
import {
  cvStructureSchema,
  letterLinkSchema,
  letterParagraphSchema,
  rewriteLlmSchema,
  type CvStructureOutput,
} from "@/schemas/tailoring";

const { getJobById, generateStructured } = vi.hoisted(() => ({
  getJobById: vi.fn(),
  generateStructured: vi.fn(),
}));

vi.mock("@/lib/jobs/repository", () => ({ getJobById }));
vi.mock("@/lib/ollama-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ollama-client")>()),
  generateStructured,
}));

import { POST as coverLetterPost } from "@/app/api/documents/cover-letter/route";
import { POST as tailorPost } from "@/app/api/documents/tailor-cv/route";
import { OllamaUnavailableError } from "@/lib/ollama-client";

const ctx = { params: Promise.resolve({}) };

const CV_TEXT = [
  "Jane Doe",
  "Senior Product Manager",
  "Acme AB, Stockholm",
  "Jan 2021 - Present",
  "• Led a team of 5 engineers to ship a payments feature used by 40% of customers",
  "• Worked with finance and legal on PSD2 compliance across 3 markets",
  "• Defined the roadmap and prioritised the backlog together with design and engineering leads",
  "• Ran weekly discovery interviews with customers and summarised the findings for the leadership team",
  "EDUCATION",
  "Stockholm University, MSc Computer Science, 2017 - 2019",
].join("\n");

const job = {
  id: "job1",
  title: "Product Lead",
  company: "Globex",
  location: "Stockholm",
  country: "Sweden",
  workMode: "HYBRID",
  seniority: "SENIOR",
  description: "Own the payments roadmap.",
  skills: ["Roadmapping"],
  requirements: ["5 years of product management"],
} as unknown as JobView;

// Step 1 of the pipeline: the model only maps the CV (bullets are line numbers).
const structure: CvStructureOutput = {
  fullName: "Jane Doe",
  location: "Stockholm",
  summaryLines: [],
  experience: [
    {
      company: "Acme AB",
      title: "Senior Product Manager",
      location: "Stockholm",
      startDate: "Jan 2021",
      endDate: "Present",
      // Line 5 of CV_TEXT (blank lines are not counted): the first bullet.
      bullets: [5],
    },
  ],
  education: [],
  additional: [],
  matchedKeywords: [],
  gaps: ["Roadmapping tools"],
  notes: [],
};

// Step 2: the model rewrites one bullet at a time.
const REWRITE = "Shipped a payments feature used by 40% of customers, leading a team of 5 engineers";

/**
 * One cover letter paragraph from the CV line in the prompt (the model writes the letter one paragraph per
 * call). A body paragraph is a condensed version of the line: here its first words, then a short sentence.
 */
function letterParagraphFor(user: string): string {
  const item = /<item>\n([\s\S]*?)\n<\/item>/.exec(user)?.[1] ?? "";
  if (user.includes("Write the opening paragraph")) return item;
  const words = item.split(/\s+/);
  const lead = words.slice(0, Math.ceil(words.length / 2)).join(" ").replace(/[.,;:]+$/, "");
  return `At Acme AB I did this: ${lead.charAt(0).toLowerCase()}${lead.slice(1)}. The rest of that work followed from it, as the line above says.`;
}

/** A link sentence that names the need it was given, without its numbers. */
function linkSentenceFor(user: string): string {
  const need = /The need of the role: (.*)/.exec(user)?.[1] ?? "";
  const plain = need.replace(/\d+\s*years?\s*of\s*/i, "").replace(/\d+/g, "").trim();
  return `That is the kind of ${plain} work that this role asks for.`;
}

const reply = (data: unknown) => ({
  data,
  model: "llama3.2:latest",
  attempts: 1,
  durationMs: 4200,
  promptTokens: 900,
  outputTokens: 300,
});

/** Answers each call by the schema it was given, like the real model would. */
function installModel() {
  generateStructured.mockImplementation(async (options: { schema: unknown; user: string }) => {
    if (options.schema === cvStructureSchema) return reply(structure);
    if (options.schema === rewriteLlmSchema) return reply({ rewrite: REWRITE });
    if (options.schema === letterParagraphSchema) return reply({ paragraph: letterParagraphFor(options.user) });
    if (options.schema === letterLinkSchema) return reply({ sentence: linkSentenceFor(options.user) });
    throw new Error("unexpected schema");
  });
}

function post(handler: typeof tailorPost, body: unknown, url: string, headers: Record<string, string> = {}) {
  return handler(
    new NextRequest(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  getJobById.mockResolvedValue(job);
  installModel();
});

afterEach(() => {
  getJobById.mockReset();
  generateStructured.mockReset();
  vi.restoreAllMocks();
});

describe("POST /api/documents/tailor-cv", () => {
  const url = "/api/documents/tailor-cv";

  it("returns a review draft with the prompt file and hash for traceability", async () => {
    const res = await post(tailorPost, { jobId: "job1", resumeText: CV_TEXT }, url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: { experience: Array<{ company: string; bullets: Array<{ original: string; text: string }> }> };
      meta: { model: string; promptFile: string; promptHash: string };
    };
    expect(body.draft.experience[0]?.company).toBe("Acme AB");
    expect(body.draft.experience[0]?.bullets[0]?.original).toContain("Led a team of 5 engineers");
    expect(body.meta).toMatchObject({ model: "llama3.2:latest", promptFile: "config/prompts/cv-coach.md" });
    expect(body.meta.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("first reads the CV (coach prompt, job and numbered CV), then rewrites each bullet in its own small call", async () => {
    await post(tailorPost, { jobId: "job1", resumeText: CV_TEXT, model: "qwen2.5:7b" }, url);

    const read = generateStructured.mock.calls[0]?.[0] as { system: string; user: string; model: string; schema: unknown };
    expect(read.schema).toBe(cvStructureSchema);
    expect(read.system).toContain("NEVER invent");
    expect(read.system).not.toContain("<!--");
    expect(read.user).toContain("<job_posting>");
    expect(read.user).toContain("Title: Product Lead");
    expect(read.user).toContain("<candidate_cv>");
    expect(read.user).toContain("[5] Led a team of 5 engineers");
    expect(read.model).toBe("qwen2.5:7b");

    const rewrites = generateStructured.mock.calls
      .slice(1)
      .map(([options]) => options as { system: string; user: string; schema: unknown });
    expect(rewrites.length).toBeGreaterThan(0);
    for (const call of rewrites) expect(call.schema).toBe(rewriteLlmSchema);
    const bullet = rewrites.find((call) => call.user.includes("Led a team of 5 engineers"));
    expect(bullet).toBeDefined();
    expect(bullet?.system).toContain("Bullet Coach");
    expect(bullet?.user).toContain("<item>");
    expect(bullet?.user).toContain("Senior Product Manager at Acme AB");
    // the rewrite call sees one bullet, not the whole CV
    expect(bullet?.user).not.toContain("<candidate_cv>");
    expect(bullet?.user).not.toContain("Ran weekly discovery interviews");
  });

  it("streams progress lines and then the result when the browser asks for NDJSON", async () => {
    const res = await post(tailorPost, { jobId: "job1", resumeText: CV_TEXT }, url, { accept: "application/x-ndjson" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await res.text())
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string; stage?: string; result?: { draft: { experience: unknown[] } } });
    expect(events[0]).toMatchObject({ type: "progress", stage: "reading" });
    expect(events.some((event) => event.type === "progress" && event.stage === "rewriting")).toBe(true);
    const last = events.at(-1);
    expect(last?.type).toBe("result");
    expect(last?.result?.draft.experience).toHaveLength(1);
  });

  it("sends a failure as the last NDJSON line, in the usual error shape (the UI shows its fallback panel)", async () => {
    generateStructured.mockRejectedValue(new OllamaUnavailableError("http://localhost:11434", "llama3.2"));
    const res = await post(tailorPost, { jobId: "job1", resumeText: CV_TEXT }, url, { accept: "application/x-ndjson" });
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n").filter((line) => line.trim() !== "");
    const last = JSON.parse(lines.at(-1) ?? "{}") as { type: string; error: { code: string; details: { steps: string[] } } };
    expect(last.type).toBe("error");
    expect(last.error.code).toBe("OLLAMA_UNAVAILABLE");
    expect(last.error.details.steps.length).toBeGreaterThan(0);
  });

  it("still validates before streaming starts (a bad request is a normal 400, not a stream)", async () => {
    const res = await post(tailorPost, { resumeText: CV_TEXT }, url, { accept: "application/x-ndjson" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION_ERROR");
  });

  it("answers 404 for an unknown job", async () => {
    getJobById.mockResolvedValue(null);
    const res = await post(tailorPost, { jobId: "nope", resumeText: CV_TEXT }, url);
    expect(res.status).toBe(404);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const res = await post(tailorPost, { resumeText: CV_TEXT }, url);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION_ERROR");
    const badModel = await post(tailorPost, { jobId: "job1", resumeText: CV_TEXT, model: "x; rm -rf /" }, url);
    expect(badModel.status).toBe(400);
  });

  it("rejects a CV that is too short to tailor", async () => {
    const res = await post(tailorPost, { jobId: "job1", resumeText: "Jane Doe, product manager." }, url);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toContain("too short");
  });

  it("answers 503 with setup steps when Ollama is not running (the UI shows its fallback panel)", async () => {
    generateStructured.mockRejectedValue(new OllamaUnavailableError("http://localhost:11434", "llama3.2"));
    const res = await post(tailorPost, { jobId: "job1", resumeText: CV_TEXT }, url);
    expect(res.status).toBe(503);
    const error = await errorOf(res);
    expect(error.code).toBe("OLLAMA_UNAVAILABLE");
    expect((error.details as { steps: string[] }).steps.length).toBeGreaterThan(0);
  });
});

describe("POST /api/documents/cover-letter", () => {
  const url = "/api/documents/cover-letter";

  it("builds the letter paragraph by paragraph, with evidence snapped to the CV and a closing from code", async () => {
    const res = await post(coverLetterPost, { jobId: "job1", resumeText: CV_TEXT }, url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: { paragraphs: Array<{ text: string; evidence: string[]; flags: string[] }> };
      meta: { promptFile: string; model: string };
    };
    const paragraphs = body.draft.paragraphs;
    // this CV has no summary section: a template opening, then one paragraph per chosen CV line, then the closing
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(paragraphs[0]?.text).toContain("Product Lead");
    expect(paragraphs[0]?.text).toContain("Globex");
    expect(paragraphs[0]?.flags).toEqual([]);
    for (const paragraph of paragraphs.slice(1, -1)) {
      expect(paragraph.evidence).toHaveLength(1);
      expect(paragraph.text.length).toBeGreaterThan(40);
      expect(paragraph.flags).toEqual([]);
    }
    expect(paragraphs.at(-1)?.text).toContain("Globex");
    expect(body.meta.promptFile).toBe("config/prompts/cover-letter.md");
    expect(body.meta.model).toBe("llama3.2:latest");
  });

  it("asks the model for one small paragraph at a time, from one CV line", async () => {
    await post(coverLetterPost, { jobId: "job1", resumeText: CV_TEXT }, url);
    const calls = generateStructured.mock.calls.map(([options]) => options as { system: string; user: string; schema: unknown });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect([letterParagraphSchema, letterLinkSchema]).toContain(call.schema);
      expect(call.system).toContain("Cover Letter Coach");
      expect(call.user).toContain("<item>");
      // the model never sees the whole CV
      expect(call.user).not.toContain("<candidate_cv>");
    }
  });

  it("answers 503 with setup steps when Ollama is not running", async () => {
    generateStructured.mockRejectedValue(new OllamaUnavailableError("http://localhost:11434", "llama3.2"));
    const res = await post(coverLetterPost, { jobId: "job1", resumeText: CV_TEXT }, url);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("OLLAMA_UNAVAILABLE");
  });
});

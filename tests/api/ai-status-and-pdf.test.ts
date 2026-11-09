import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";

const { renderCvPdf, renderCoverLetterPdf } = vi.hoisted(() => ({
  renderCvPdf: vi.fn(),
  renderCoverLetterPdf: vi.fn(),
}));
vi.mock("@/lib/pdf/render", () => ({ renderCvPdf, renderCoverLetterPdf }));

import { POST as pdfPost } from "@/app/api/documents/pdf/route";
import { GET as statusGet } from "@/app/api/ai/status/route";

const ctx = { params: Promise.resolve({}) };

describe("GET /api/ai/status", () => {
  beforeEach(() => resetEnvCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEnvCache();
  });

  it("answers 200 with available:false (not an error) when Ollama is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const res = await statusGet(new NextRequest("http://localhost/api/ai/status"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, reason: "unreachable", activeModel: null });
  });

  it("lists the installed models when Ollama is running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 })),
    );
    const res = await statusGet(new NextRequest("http://localhost/api/ai/status"), ctx);
    expect(await res.json()).toMatchObject({ available: true, installedModels: ["llama3.2:latest"] });
  });
});

const cvDocument = {
  fullName: "Åsa Öberg",
  email: "asa@example.com",
  phone: "",
  location: "Stockholm",
  links: [],
  summary: "Product manager.",
  skills: ["Jira"],
  experience: [
    { title: "PM", company: "Acme", location: "", startDate: "2021", endDate: "Present", bullets: ["Shipped payments"] },
  ],
  education: [],
  additional: [],
};

function pdfRequest(body: unknown) {
  return pdfPost(
    new NextRequest("http://localhost/api/documents/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

describe("POST /api/documents/pdf", () => {
  beforeEach(() => {
    renderCvPdf.mockResolvedValue(Buffer.from("%PDF-1.7 test"));
    renderCoverLetterPdf.mockResolvedValue(Buffer.from("%PDF-1.7 letter"));
  });
  afterEach(() => {
    renderCvPdf.mockReset();
    renderCoverLetterPdf.mockReset();
  });

  it("returns a PDF download with an ASCII-only file name", async () => {
    const res = await pdfRequest({ kind: "cv", document: cvDocument });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Asa-Oberg-CV.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toContain("%PDF");
    expect(renderCvPdf).toHaveBeenCalledOnce();
  });

  it("renders a cover letter", async () => {
    const res = await pdfRequest({
      kind: "cover-letter",
      document: {
        senderName: "Jane Doe",
        email: "",
        phone: "",
        location: "",
        date: "8 November 2026",
        company: "Globex",
        jobTitle: "Product Lead",
        greeting: "Dear Hiring Team,",
        paragraphs: ["One paragraph."],
        closing: "Thank you.",
        signOff: "Sincerely,",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("Jane-Doe-Cover-Letter.pdf");
  });

  it("rejects an invalid document with 400 and never calls the renderer", async () => {
    expect((await pdfRequest({ kind: "cv", document: { ...cvDocument, fullName: "" } })).status).toBe(400);
    expect((await pdfRequest({ kind: "cv", document: { ...cvDocument, experience: "nope" } })).status).toBe(400);
    expect((await pdfRequest({ kind: "html", document: "<b>x</b>" })).status).toBe(400);
    expect(renderCvPdf).not.toHaveBeenCalled();
  });
});

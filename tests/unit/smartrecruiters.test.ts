import { describe, expect, it } from "vitest";
import { parseRestFeed } from "@/lib/feeds/adapters";
import { getFeedConfig, type ResolvedFeed } from "@/lib/feeds/config";
import { prepareItem } from "@/lib/feeds/normalize";
import {
  companyIdFromUrl,
  loadSmartRecruitersItems,
  MAX_DETAILS_PER_SYNC,
  parseDetail,
  parseListPage,
} from "@/lib/feeds/smartrecruiters";

function listEntry(index: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: String(1000 + index),
    name,
    company: { name: "Wise" },
    releasedDate: "2026-11-01T10:00:00.000Z",
    location: { city: "London", country: "gb", remote: false },
    language: { code: "en" },
    typeOfEmployment: { label: "Full-time" },
    ...extra,
  };
}

const DETAIL = JSON.stringify({
  applyUrl: "https://jobs.smartrecruiters.com/Wise/apply",
  jobAd: {
    sections: {
      jobDescription: { title: "Job <Description>", text: "<p>Build things</p>" },
      qualifications: { title: "Qualifications", text: "<ul><li>5 years</li></ul>" },
    },
  },
});

describe("SmartRecruiters reader", () => {
  it("reads list pages and the detail text", () => {
    const page = parseListPage(JSON.stringify({ totalFound: 7, content: [listEntry(1, "Product Manager"), { nope: true }] }));
    expect(page.total).toBe(7);
    expect(page.postings).toHaveLength(1);
    expect(page.postings[0]).toMatchObject({ id: "1001", title: "Product Manager", city: "London", countryName: "United Kingdom", remote: false });

    const detail = parseDetail(DETAIL);
    expect(detail.description).toContain("<h3>Job &lt;Description&gt;</h3>");
    expect(detail.description).toContain("<li>5 years</li>");
    expect(detail.applyUrl).toBe("https://jobs.smartrecruiters.com/Wise/apply");
    expect(() => parseListPage("<html>")).toThrow(/JSON/);
    expect(() => parseListPage('{"x":1}')).toThrow(/content/);
    expect(companyIdFromUrl("https://api.smartrecruiters.com/v1/companies/Wise/postings?limit=1")).toBe("Wise");
  });

  it("pages through the list, drops what the list rules out and what is stored, and caps the text requests", async () => {
    const all = Array.from({ length: 230 }, (_, i) => listEntry(i, i % 3 === 0 ? `Senior Product Manager ${i}` : `Account Executive ${i}`));
    all.push(listEntry(900, "Software Engineer", { location: { city: "Austin", country: "us", remote: false } }));
    all.push(listEntry(901, "Web Developer", { language: { code: "pl" } }));

    const requests: string[] = [];
    const fetchText = async (url: string): Promise<string> => {
      requests.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/postings")) {
        const limit = Number(parsed.searchParams.get("limit"));
        const offset = Number(parsed.searchParams.get("offset"));
        return JSON.stringify({ totalFound: all.length, content: all.slice(offset, offset + limit) });
      }
      if (parsed.pathname.endsWith("/1003")) throw new Error("detail failed");
      return DETAIL;
    };

    const result = await loadSmartRecruitersItems("https://api.smartrecruiters.com/v1/companies/Wise/postings", "Wise", {
      fetchText,
      maxItems: 500,
      skip: (posting) => {
        if (!/manager|engineer|developer/i.test(posting.title)) return "role";
        if (posting.languageCode !== undefined && posting.languageCode !== "en") return "language";
        if (!posting.remote && posting.countryName === "United States") return "region";
        return undefined;
      },
      isKnown: async (items) => items.map((item) => item.externalId === "1012"),
    });

    expect(requests.filter((url) => url.includes("limit="))).toHaveLength(3);
    expect(result.listed).toBe(232);
    expect(result.skipped).toMatchObject({ language: 1, region: 1, known: 1, failed: 1 });
    expect(result.items.length + result.postponed + result.skipped.failed).toBe(77 - 1);
    expect(requests.filter((url) => !url.includes("limit="))).toHaveLength(MAX_DETAILS_PER_SYNC);

    const first = result.items[0];
    expect(first).toMatchObject({
      company: "Wise",
      location: "London",
      country: "United Kingdom",
      url: "https://jobs.smartrecruiters.com/Wise/1000",
      applyUrl: "https://jobs.smartrecruiters.com/Wise/apply",
    });
    // The item is complete enough for the normal pipeline.
    expect(first && prepareItem(first, new Date("2026-11-08T12:00:00Z")).ok).toBe(true);
  });
});

describe("Recruitee mapping", () => {
  it("maps an offers response to items", () => {
    const feed = getFeedConfig().feeds.find((candidate) => candidate.id === "recruitee:bunq") as ResolvedFeed;
    const body = {
      offers: [
        {
          id: 42,
          title: "Business Analyst",
          company_name: "bunq",
          description: "<p>Analyse things for the bank.</p>",
          location: "Amsterdam, Netherlands",
          country: "Netherlands",
          remote: true,
          careers_url: "https://bunq.recruitee.com/o/business-analyst",
          published_at: "2026-11-02T09:00:00.000Z",
          employment_type_code: "fulltime",
        },
      ],
    };
    const parsed = parseRestFeed(feed, JSON.stringify(body), 50);
    expect(parsed.items[0]).toMatchObject({
      title: "Business Analyst",
      company: "bunq",
      url: "https://bunq.recruitee.com/o/business-analyst",
      location: "Amsterdam, Netherlands",
      workModeText: "true",
    });
  });
});

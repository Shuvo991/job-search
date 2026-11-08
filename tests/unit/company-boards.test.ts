import { describe, expect, it } from "vitest";
import { mergeCompanyBoards, readCompanyBoards } from "@/lib/feeds/company-boards";
import { parseFeedConfig } from "@/lib/feeds/config";

const settings = {
  userAgent: "test-agent/1.0",
  requestTimeoutMs: 5000,
  maxResponseBytes: 100_000,
  maxRedirects: 3,
  concurrency: 2,
  maxItemsPerFeed: 50,
  failureBackoffMinutes: 5,
};

const fields = { id: "id", title: "title", url: "url", description: "description" };

const baseConfig = {
  version: "t",
  settings,
  feeds: [
    {
      id: "greenhouse",
      name: "Greenhouse",
      type: "rest-json",
      url: "https://boards-api.greenhouse.io/v1/boards/{board}/jobs",
      itemsPath: "jobs",
      fields,
      instances: [{ id: "gitlab", company: "GitLab", vars: { board: "gitlab" } }],
    },
    {
      id: "lever",
      name: "Lever",
      type: "rest-json",
      url: "https://api.lever.co/v0/postings/{company}",
      fields,
      instances: [{ id: "spotify", company: "Spotify", vars: { company: "spotify" } }],
    },
  ],
};

describe("company boards", () => {
  it("skips malformed entries and reads both the found and the approved lists", () => {
    const boards = readCompanyBoards({
      boards: [
        { company: "Klarna", ats: "greenhouse", slug: "klarna" },
        { company: "Bad system", ats: "workday", slug: "x" },
        { company: "Bad slug", ats: "ashby", slug: "not a slug!" },
        "nonsense",
      ],
      manual: [{ company: "Manual Co", ats: "lever", slug: "manualco" }],
    });
    expect(boards.map((board) => `${board.ats}:${board.slug}`)).toEqual(["greenhouse:klarna", "lever:manualco"]);
    expect(readCompanyBoards(undefined)).toEqual([]);
  });

  it("adds instances without changing the input, and skips boards that are already configured", () => {
    const before = JSON.stringify(baseConfig);
    const merged = mergeCompanyBoards(baseConfig, {
      boards: [
        { company: "Klarna", ats: "greenhouse", slug: "klarna" },
        { company: "GitLab again", ats: "greenhouse", slug: "gitlab" },
        { company: "Einride", ats: "lever-eu", slug: "einride" },
      ],
    });
    expect(JSON.stringify(baseConfig)).toBe(before);

    const loaded = parseFeedConfig(merged);
    const ids = loaded.feeds.map((feed) => feed.id);
    expect(ids).toEqual(["greenhouse:gitlab", "greenhouse:klarna", "lever:spotify", "lever-eu:einride"]);
    const eu = loaded.feeds.find((feed) => feed.id === "lever-eu:einride");
    expect(eu?.url).toBe("https://api.eu.lever.co/v0/postings/einride");
  });

  it("returns the config untouched when there are no boards", () => {
    expect(mergeCompanyBoards(baseConfig, { boards: [], manual: [] })).toBe(baseConfig);
  });
});

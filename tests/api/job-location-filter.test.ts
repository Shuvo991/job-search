import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakePrisma } from "../helpers/fake-prisma";

vi.mock("@/lib/db", () => import("../helpers/fake-prisma").then((module) => ({ prisma: module.fakePrisma })));

import { buildJobFromRequest } from "@/lib/jobs/build-job";
import { createJob, getJobFacets, listJobs } from "@/lib/jobs/repository";
import { createPlaceIndex, getPlaceIndex } from "@/lib/geo-places";
import { normalizeForMatching } from "@/lib/language-filter";
import rulesJson from "../../config/geo-rules.json";

const base = { mode: "structured", company: "Acme", description: "Text", skills: [] as string[], roleCategory: "SOFTWARE_ENGINEER" } as const;

async function add(title: string, location: string | undefined, country: string | undefined, workMode: "REMOTE" | "ONSITE" | "HYBRID" = "ONSITE") {
  const request = { ...base, title, workMode, ...(location ? { location } : {}), ...(country ? { country } : {}) };
  await createJob(buildJobFromRequest(request as never, new Date("2026-11-08T10:00:00Z")));
}

async function titles(location: string): Promise<string[]> {
  const page = await listJobs({ location, skills: [], page: 1, pageSize: 50 } as never);
  return page.items.map((item) => item.title).sort();
}

beforeEach(async () => {
  resetFakePrisma();
  await add("A Stockholm, no country", "Stockholm", undefined);
  await add("B Sverige", "Södertälje", "Sverige");
  await add("C Göteborg", "Göteborg", undefined);
  await add("D Berlin", "Berlin", "Germany");
  await add("E UK short", "UK", undefined, "REMOTE");
  await add("F Ukraine", "Kyiv", undefined);
  await add("G Remote EMEA", "EMEA", undefined, "REMOTE");
  await add("H Anywhere", "Anywhere in the World", undefined, "REMOTE");
  await add("I Remote OK blank", undefined, undefined, "REMOTE");
  await add("J Boston", "Boston", undefined);
});

describe("Location filter", () => {
  it("finds a country through its cities and other spellings", async () => {
    expect(await titles("Sweden")).toEqual(["A Stockholm, no country", "B Sverige", "C Göteborg"]);
    expect(await titles("sverige")).toEqual(["A Stockholm, no country", "B Sverige", "C Göteborg"]);
    expect(await titles("Germany")).toEqual(["D Berlin"]);
  });

  it("matches short names whole, so UK does not pull in Ukraine", async () => {
    expect(await titles("United Kingdom")).toEqual(["E UK short"]);
    expect(await titles("UK")).toEqual(["E UK short"]);
  });

  it("supports Europe and Worldwide", async () => {
    expect(await titles("Europe")).toEqual(["G Remote EMEA"]);
    expect(await titles("Worldwide")).toEqual(["H Anywhere", "I Remote OK blank"]);
  });

  it("still searches plain text for anything else", async () => {
    expect(await titles("boston")).toEqual(["J Boston"]);
    expect(await titles("stock")).toEqual(["A Stockholm, no country"]);
  });
});

describe("Country and City filters", () => {
  async function inPlace(country: string | undefined, city: string | undefined): Promise<string[]> {
    const page = await listJobs({ ...(country ? { country } : {}), ...(city ? { city } : {}), skills: [], page: 1, pageSize: 50 } as never);
    return page.items.map((item) => item.title).sort();
  }

  it("filters by country", async () => {
    expect(await inPlace("Sweden", undefined)).toEqual(["A Stockholm, no country", "B Sverige", "C Göteborg"]);
    expect(await inPlace("Worldwide", undefined)).toEqual(["H Anywhere", "I Remote OK blank"]);
  });

  it("filters by city inside the country, under any spelling", async () => {
    expect(await inPlace("Sweden", "Göteborg")).toEqual(["C Göteborg"]);
    expect(await inPlace("Sweden", "Stockholm")).toEqual(["A Stockholm, no country"]);
    expect(await inPlace(undefined, "Berlin")).toEqual(["D Berlin"]);
  });

  it("finds nothing when the city is not in that country", async () => {
    expect(await inPlace("Sweden", "Berlin")).toEqual([]);
    expect(await inPlace("Germany", "Stockholm")).toEqual([]);
  });

  it("offers each country with only its own cities", async () => {
    const { countries, regions } = await getJobFacets();
    expect(countries.map((country) => [country.name, country.count])).toEqual([
      ["Sweden", 3],
      ["Germany", 1],
      ["Ukraine", 1],
      ["United Kingdom", 1],
    ]);
    const cities = (name: string) => countries.find((country) => country.name === name)?.cities.map((city) => city.name);
    expect(cities("Sweden")).toEqual(["Göteborg", "Södertälje", "Stockholm"]);
    expect(cities("Germany")).toEqual(["Berlin"]);
    expect(cities("Ukraine")).toEqual(["Kyiv"]);
    expect(cities("United Kingdom")).toEqual([]); // "UK" names a country, not a city
    expect(regions).toEqual([
      { name: "Europe", count: 1 },
      { name: "Worldwide", count: 2 },
    ]);
  });
});

describe("Place index", () => {
  it("does not call London, Ontario or Cambridge, MA British", () => {
    const index = getPlaceIndex();
    expect(index.resolve("London", undefined)).toEqual({ country: "United Kingdom", city: "London" });
    expect(index.resolve("London, Ontario", undefined)).toEqual({});
    expect(index.resolve("Cambridge, MA", undefined)).toEqual({});
    expect(index.resolve("Remote", "Sverige")).toEqual({ country: "Sweden" });
  });

  it("merges spellings of a city and keeps unknown single places", () => {
    const index = getPlaceIndex();
    expect(index.resolve("Gothenburg", undefined)).toEqual({ country: "Sweden", city: "Göteborg" });
    expect(index.resolve("München", "Germany")).toEqual({ country: "Germany", city: "Munich" });
    expect(index.resolve("Finspång", "Sverige")).toEqual({ country: "Sweden", city: "Finspång" });
    expect(index.resolve("Stockholm, Sverige", undefined)).toEqual({ country: "Sweden", city: "Stockholm" });
  });
});

describe("config/geo-rules.json country groups", () => {
  it("every group city is also a city the location gate recognises", () => {
    const known = new Set(rulesJson.europe.cities.map(normalizeForMatching));
    const missing = rulesJson.europe.countryGroups.flatMap((group) => group.cities).filter((city) => !known.has(normalizeForMatching(city)));
    expect(missing).toEqual([]);
  });

  it("rejects a group without a name", () => {
    const bad = { ...rulesJson, europe: { ...rulesJson.europe, countryGroups: [{ aliases: [], cities: [] }] } };
    expect(() => createPlaceIndex(bad)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { createGeoFilter, evaluateGeo, getGeoFilter, parseGeoRules } from "@/lib/geo-filter";
import { getFeedConfig } from "@/lib/feeds/config";
import { planGeoPrune } from "@/lib/jobs/geo-prune";
import rulesJson from "../../config/geo-rules.json";

const keep = (workMode: string, location: string | undefined, extra: Record<string, unknown> = {}) =>
  evaluateGeo({ workMode, location, ...extra });

describe("on-site, hybrid and unknown work modes need a European place", () => {
  it.each([
    ["ONSITE", "Stockholm"],
    ["HYBRID", "Göteborg", "Sverige"],
    ["UNKNOWN", "London"],
    ["UNKNOWN", "United Kingdom, London"],
    ["UNKNOWN", "Zilch UK"],
    ["HYBRID", "Berlin; Chemnitz, Sachsen; Dresden, Sachsen"],
    ["UNKNOWN", "Paris, France"],
    ["UNKNOWN", undefined, "Danmark"],
    ["UNKNOWN", undefined, "Schweiz"],
    ["UNKNOWN", "Europe"],
    ["HYBRID", "Frankfurt am Main"],
    ["ONSITE", "Wien"],
    ["UNKNOWN", "Kraków"],
  ])("keeps %s in %s %s", (workMode, location, country) => {
    expect(evaluateGeo({ workMode: workMode as string, location, country })).toMatchObject({ accepted: true, basis: "europe" });
  });

  it.each([
    ["ONSITE", "New York City"],
    ["HYBRID", "Boston"],
    ["UNKNOWN", "United States"],
    ["ONSITE", "Toronto, Ontario"],
    ["ONSITE", "Austin, TX"],
    ["HYBRID", "San Francisco, CA"],
    ["UNKNOWN", "Bengaluru, India"],
    ["ONSITE", "Sydney"],
    ["ONSITE", "Cambridge, Massachusetts"],
    ["ONSITE", "London, Ontario"],
    ["ONSITE", "London, Canada"],
    ["ONSITE", "Paris, Texas"],
  ])("rejects %s in %s", (workMode, location) => {
    expect(keep(workMode, location)).toMatchObject({ accepted: false, reason: "outside_europe" });
  });

  it("rejects ads with no place at all", () => {
    expect(keep("UNKNOWN", undefined)).toEqual({ accepted: false, reason: "no_location" });
    expect(keep("ONSITE", "  ")).toEqual({ accepted: false, reason: "no_location" });
    expect(keep("HYBRID", "Office")).toEqual({ accepted: false, reason: "no_location" });
  });

  it("does not treat a place name inside another word as a match", () => {
    expect(keep("ONSITE", "Plusvalia")).toMatchObject({ accepted: false });
    expect(keep("ONSITE", "Business Bay, Dubai")).toMatchObject({ accepted: false, reason: "outside_europe" });
  });

  it("uses the feed's default country only when the location is not recognised", () => {
    expect(evaluateGeo({ workMode: "ONSITE", location: "Kiruna Centrum", defaultCountry: "Sweden" })).toMatchObject({ accepted: true });
    expect(evaluateGeo({ workMode: "ONSITE", location: undefined, defaultCountry: "Germany" })).toMatchObject({ accepted: true });
    expect(evaluateGeo({ workMode: "ONSITE", location: "New York", defaultCountry: "Sweden" })).toMatchObject({
      accepted: false,
      reason: "outside_europe",
    });
  });

  it("accepts a European country given separately from the city", () => {
    expect(evaluateGeo({ workMode: "UNKNOWN", location: "Södertälje", country: "Sverige" })).toMatchObject({ accepted: true });
  });
});

describe("remote jobs", () => {
  it.each(["Worldwide", "Anywhere", "Anywhere in the World", "Work from anywhere", "Global"])("keeps '%s'", (location) => {
    expect(keep("REMOTE", location)).toEqual({ accepted: true, basis: "worldwide_remote" });
  });

  it.each([
    "Remote (Europe)",
    "EMEA",
    "EMEA, LATAM, Canada, USA",
    "Europe, LATAM, APAC, the U.S., Canada",
    "Europe, USA, Canada, Australia, Singapore, Mexico",
    "Germany, Ireland, Spain, UK",
    "Netherlands, Portugal",
    "Albania",
    "Stockholm",
    "Austria, Croatia, Germany, Hungary, Italy, Portugal, Spain, UK",
    "Nordics",
  ])("keeps '%s' as a European remote job", (location) => {
    expect(keep("REMOTE", location)).toEqual({ accepted: true, basis: "europe_remote" });
  });

  it.each([
    "United States",
    "USA, Canada, USA timezones",
    "India",
    "Kansas",
    "Boston",
    "Palo Alto",
    "Toronto, Ontario",
    "Melbourne",
    "Seoul",
    "New York, NY",
    "APAC",
    "LATAM",
    "Uluberia-II,",
  ])("rejects '%s'", (location) => {
    expect(keep("REMOTE", location)).toMatchObject({ accepted: false, reason: "remote_not_worldwide" });
  });

  it("can require worldwide-only remote jobs", () => {
    const strict = createGeoFilter({ ...rulesJson, policy: { ...rulesJson.policy, remoteTiedToEurope: "reject" } });
    expect(strict.evaluate({ workMode: "REMOTE", location: "Europe" })).toMatchObject({ accepted: false, reason: "remote_not_worldwide" });
    expect(strict.evaluate({ workMode: "REMOTE", location: "Worldwide" })).toMatchObject({ accepted: true });
  });

  describe("without a place", () => {
    it("drops the job by default", () => {
      expect(keep("REMOTE", undefined)).toEqual({ accepted: false, reason: "no_location" });
      expect(keep("REMOTE", "Remote")).toEqual({ accepted: false, reason: "no_location" });
    });

    it("keeps it when the feed says an empty location means worldwide", () => {
      expect(keep("REMOTE", "Remote", { worldwideWhenNoLocation: true })).toEqual({ accepted: true, basis: "unspecified_remote" });
      expect(keep("REMOTE", undefined, { worldwideWhenNoLocation: true })).toEqual({ accepted: true, basis: "unspecified_remote" });
    });

    it("keeps it when the description clearly says worldwide", () => {
      expect(keep("REMOTE", undefined, { description: "This is a fully remote role: you can work from anywhere." })).toMatchObject({
        accepted: true,
      });
      expect(keep("REMOTE", undefined, { description: "Our customers worldwide love our product." })).toMatchObject({ accepted: false });
    });

    it("can keep every unplaced remote job if the policy says so", () => {
      const lenient = createGeoFilter({ ...rulesJson, policy: { ...rulesJson.policy, unspecifiedRemote: "keep" } });
      expect(lenient.evaluate({ workMode: "REMOTE" })).toMatchObject({ accepted: true });
    });
  });

  describe("limits written into the description", () => {
    it.each([
      "Candidates must be located in the United States.",
      "You must be authorized to work in the US without sponsorship.",
      "This position is open to US citizens only.",
      "We can only hire people who are U.S. based.",
      "Applicants must reside in Canada.",
      "Must be legally authorised to work in India.",
    ])("drops a worldwide remote job that says: %s", (sentence) => {
      expect(keep("REMOTE", "Worldwide", { description: `Great team. ${sentence} Apply today.` })).toMatchObject({
        accepted: false,
        reason: "remote_restricted",
      });
    });

    it("ignores a limit that is followed by a European alternative", () => {
      expect(
        keep("REMOTE", "Anywhere", { description: "You must be located in the United States or Europe, with some overlap." }),
      ).toMatchObject({ accepted: true });
    });

    it("does not misread ordinary text", () => {
      expect(keep("REMOTE", "Worldwide", { description: "Join us. Our customers are based in the US and Europe." })).toMatchObject({
        accepted: true,
      });
    });

    it("applies the same check to unplaced remote jobs", () => {
      expect(
        keep("REMOTE", undefined, { worldwideWhenNoLocation: true, description: "Candidates must be located in the United States." }),
      ).toMatchObject({ accepted: false, reason: "remote_restricted" });
    });

    it("can be switched off", () => {
      const off = createGeoFilter({ ...rulesJson, policy: { ...rulesJson.policy, checkDescription: false } });
      expect(off.evaluate({ workMode: "REMOTE", location: "Worldwide", description: "US citizens only." })).toMatchObject({ accepted: true });
    });
  });
});

describe("config/geo-rules.json", () => {
  it("is valid and loads", () => {
    const rules = parseGeoRules(rulesJson);
    expect(rules.europe.countries).toEqual(expect.arrayContaining(["sweden", "sverige", "united kingdom"]));
    expect(getGeoFilter().rules.policy).toMatchObject({ remoteTiedToEurope: "keep", unspecifiedRemote: "reject" });
  });

  it("rejects a typo'd key", () => {
    expect(() => parseGeoRules({ ...rulesJson, polcy: {} })).toThrow();
  });

  it("flags Remote OK as the one feed whose empty location means worldwide", () => {
    const flagged = getFeedConfig().feeds.filter((feed) => feed.worldwideWhenNoLocation).map((feed) => feed.id);
    expect(flagged).toEqual(["remoteok"]);
  });
});

describe("planGeoPrune", () => {
  const base = {
    title: "Engineer",
    company: "Acme",
    location: "Stockholm",
    country: null,
    workMode: "ONSITE",
    description: "A job.",
    sourceName: "Feed",
    externalId: "1",
    applications: 0,
    documents: 0,
  };
  const jobs = [
    { ...base, id: "keep-eu" },
    { ...base, id: "drop-ny", location: "New York" },
    { ...base, id: "drop-us-remote", location: "United States", workMode: "REMOTE" },
    { ...base, id: "keep-worldwide", location: "Worldwide", workMode: "REMOTE" },
    { ...base, id: "in-use", location: "Boston", applications: 1 },
    { ...base, id: "by-hand", location: "Boston", externalId: null },
    { ...base, id: "remoteok-empty", location: null, workMode: "REMOTE", sourceName: "Remote OK" },
    { ...base, id: "other-empty", location: null, workMode: "REMOTE" },
    { ...base, id: "default-country", location: null, country: "Sweden" },
  ];

  it("lists what breaks the rule and spares jobs you added or work on", () => {
    const report = planGeoPrune(jobs, getGeoFilter(), new Set(["Remote OK"]));
    expect(report.remove.map((item) => item.id).sort()).toEqual(["drop-ny", "drop-us-remote", "other-empty"]);
    expect(report.keptBecauseInUse.map((item) => item.id)).toEqual(["in-use"]);
    expect(report).toMatchObject({ skipped: 1, checked: 8 });
  });
});

/**
 * Company career boards found by `npm run discover:boards` (config/company-boards.json) are added
 * to the feed config as extra instances of the Greenhouse, Lever, Ashby and Teamtailor feeds, so
 * the normal sync (button and background) crawls them with the same filters as every other source.
 *
 * Pure functions on plain JSON: no network, no file access. Malformed entries are skipped rather
 * than breaking the whole config.
 */

export type BoardSystem = "greenhouse" | "lever" | "lever-eu" | "ashby" | "teamtailor" | "recruitee" | "smartrecruiters";

export interface CompanyBoard {
  company: string;
  ats: BoardSystem;
  slug: string;
}

/** Which feed each system belongs to, and the name of the {placeholder} in that feed's URL. */
const SYSTEMS: Record<BoardSystem, { feedId: string; variable: string }> = {
  greenhouse: { feedId: "greenhouse", variable: "board" },
  lever: { feedId: "lever", variable: "company" },
  "lever-eu": { feedId: "lever-eu", variable: "company" },
  ashby: { feedId: "ashby", variable: "board" },
  teamtailor: { feedId: "teamtailor", variable: "company" },
  recruitee: { feedId: "recruitee", variable: "company" },
  smartrecruiters: { feedId: "smartrecruiters", variable: "company" },
};

const SLUG_VALUE = /^[A-Za-z0-9._-]{1,100}$/;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoardSystem(value: string): value is BoardSystem {
  return Object.prototype.hasOwnProperty.call(SYSTEMS, value);
}

/** Boards from both the discovered list ("boards") and the ones you approved by hand ("manual"). */
export function readCompanyBoards(raw: unknown): CompanyBoard[] {
  if (!isObject(raw)) return [];
  const boards: CompanyBoard[] = [];
  for (const key of ["boards", "manual"]) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isObject(entry)) continue;
      const company = entry["company"];
      const ats = entry["ats"];
      const slug = entry["slug"];
      if (typeof company !== "string" || company.trim() === "" || company.length > 200) continue;
      if (typeof ats !== "string" || !isBoardSystem(ats)) continue;
      if (typeof slug !== "string" || !SLUG_VALUE.test(slug)) continue;
      boards.push({ company: company.trim(), ats, slug });
    }
  }
  return boards;
}

function instanceIdFor(slug: string): string {
  const id = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return id === "" ? "board" : id;
}

/** Returns a copy of the raw feed config with one instance added per company board. */
export function mergeCompanyBoards(rawConfig: unknown, rawBoards: unknown): unknown {
  const boards = readCompanyBoards(rawBoards);
  if (boards.length === 0 || !isObject(rawConfig) || !Array.isArray(rawConfig["feeds"])) return rawConfig;

  const config = structuredClone(rawConfig);
  const feeds = config["feeds"] as unknown[];
  const findFeed = (id: string): JsonObject | undefined =>
    feeds.find((feed): feed is JsonObject => isObject(feed) && feed["id"] === id);

  for (const board of boards) {
    const system = SYSTEMS[board.ats];
    let feed = findFeed(system.feedId);

    if (feed === undefined && board.ats === "lever-eu") {
      // Lever's EU region has its own host; reuse the Lever feed's field mapping for it.
      const lever = findFeed("lever");
      const leverUrl = lever?.["url"];
      if (lever === undefined || typeof leverUrl !== "string") continue;
      feed = {
        ...structuredClone(lever),
        id: "lever-eu",
        name: "Lever (EU)",
        url: leverUrl.replace("api.lever.co", "api.eu.lever.co"),
        instances: [],
      };
      feeds.push(feed);
    }
    if (feed === undefined) continue;

    if (!Array.isArray(feed["instances"])) feed["instances"] = [];
    const instances = feed["instances"] as unknown[];

    const usedIds = new Set<string>();
    let alreadyThere = false;
    for (const instance of instances) {
      if (!isObject(instance)) continue;
      usedIds.add(String(instance["id"]));
      const vars = instance["vars"];
      if (isObject(vars) && vars[system.variable] === board.slug) alreadyThere = true;
    }
    if (alreadyThere) continue;

    const baseId = instanceIdFor(board.slug);
    let id = baseId;
    for (let n = 2; usedIds.has(id); n += 1) id = `${baseId}-${n}`;
    instances.push({ id, company: board.company, vars: { [system.variable]: board.slug } });
  }
  return config;
}

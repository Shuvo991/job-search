/**
 * SmartRecruiters company boards. The public postings API lists a company's jobs without their
 * text, so a feed with `"adapter": "smartrecruiters"` is read in steps instead of one download:
 *
 *   1. page through the list of postings (100 at a time, up to the per-feed item cap),
 *   2. drop what can be judged from the list entry alone (not one of your roles, not English,
 *      on-site outside Europe), and what is already stored,
 *   3. fetch the full text of the rest, a limited number per sync (the remainder follows on the
 *      next sync), and hand the finished items to the normal pipeline.
 *
 * Nothing here talks to the network or the database itself: the caller passes in `fetchText` and
 * `isKnown`, so it can be tested with fakes. A failing detail request only loses that one job.
 */
import { FeedParseError, type RawFeedItem } from "@/lib/feeds/adapters";

const PAGE_SIZE = 100;
/** Full-text requests per feed and sync. Jobs beyond this are picked up by the next sync. */
export const MAX_DETAILS_PER_SYNC = 40;
const DETAIL_CONCURRENCY = 2;

export interface ListedPosting {
  id: string;
  title: string;
  company: string | undefined;
  city: string | undefined;
  /** Country written out in English ("Sweden"), from the two-letter code in the list. */
  countryName: string | undefined;
  remote: boolean;
  hybrid: boolean;
  languageCode: string | undefined;
  employmentType: string | undefined;
  releasedAt: string | undefined;
}

export type SkipReason = "role" | "language" | "region";

export interface SmartRecruitersDeps {
  fetchText(url: string): Promise<string>;
  /** Most postings to read from the list. */
  maxItems: number;
  /** Why this posting can be dropped without reading its text, if it can. */
  skip(posting: ListedPosting): SkipReason | undefined;
  /** For each item (in order): is it already stored? */
  isKnown(items: RawFeedItem[]): Promise<boolean[]>;
}

export interface SmartRecruitersResult {
  /** Items with their text, ready for the normal pipeline. */
  items: RawFeedItem[];
  /** Postings read from the list. */
  listed: number;
  skipped: { role: number; language: number; region: number; known: number; failed: number };
  /** New, wanted postings left for the next sync because of MAX_DETAILS_PER_SYNC. */
  postponed: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new FeedParseError("SmartRecruiters did not answer with JSON.", { cause });
  }
}

let regionNames: Intl.DisplayNames | undefined;

function countryName(code: string | undefined): string | undefined {
  if (code === undefined || !/^[A-Za-z]{2}$/.test(code)) return undefined;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase());
  } catch {
    return undefined;
  }
}

/** One page of the postings list. Entries without an id or a title are ignored. */
export function parseListPage(body: string): { total: number; postings: ListedPosting[] } {
  const json = parseJson(body);
  if (!isObject(json) || !Array.isArray(json["content"])) {
    throw new FeedParseError('The SmartRecruiters response has no "content" list.');
  }
  const postings: ListedPosting[] = [];
  for (const entry of json["content"] as unknown[]) {
    if (!isObject(entry)) continue;
    const id = text(entry["id"]);
    const title = text(entry["name"]);
    if (id === undefined || title === undefined) continue;

    const company = isObject(entry["company"]) ? text(entry["company"]["name"]) : undefined;
    const location = isObject(entry["location"]) ? entry["location"] : {};
    const language = isObject(entry["language"]) ? text(entry["language"]["code"]) : undefined;
    const employment = isObject(entry["typeOfEmployment"]) ? text(entry["typeOfEmployment"]["label"]) : undefined;
    postings.push({
      id,
      title,
      company,
      city: text(location["city"]),
      countryName: countryName(text(location["country"])),
      remote: location["remote"] === true,
      hybrid: location["hybrid"] === true,
      languageCode: language,
      employmentType: employment,
      releasedAt: text(entry["releasedDate"]),
    });
  }
  const total = Number(json["totalFound"]);
  return { total: Number.isFinite(total) ? total : postings.length, postings };
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SECTION_ORDER = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"] as const;

/** The posting text (HTML, untrusted: it is sanitised later) and the apply link from a detail response. */
export function parseDetail(body: string): { description: string; applyUrl: string | undefined } {
  const json = parseJson(body);
  if (!isObject(json)) throw new FeedParseError("The SmartRecruiters posting is not a JSON object.");
  const jobAd = isObject(json["jobAd"]) ? json["jobAd"] : {};
  const sections = isObject(jobAd["sections"]) ? jobAd["sections"] : {};

  const parts: string[] = [];
  for (const key of SECTION_ORDER) {
    const section = sections[key];
    if (!isObject(section)) continue;
    const content = text(section["text"]);
    if (content === undefined) continue;
    const heading = text(section["title"]);
    parts.push(heading === undefined ? content : `<h3>${escapeHtml(heading)}</h3>\n${content}`);
  }
  return { description: parts.join("\n"), applyUrl: text(json["applyUrl"]) ?? text(json["postingUrl"]) };
}

/** "https://api.smartrecruiters.com/v1/companies/Wise/postings" -> "Wise". */
export function companyIdFromUrl(url: string): string | undefined {
  const match = /\/companies\/([^/?#]+)\/postings/.exec(url);
  const id = match?.[1];
  if (id === undefined) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return undefined;
  }
}

function publicUrl(companyId: string, postingId: string): string {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${encodeURIComponent(postingId)}`;
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The item as far as the list entry tells (no text yet); also used to ask whether it is stored. */
function shellItem(companyId: string, posting: ListedPosting, fallbackCompany: string | undefined): RawFeedItem {
  const item: RawFeedItem = { externalId: posting.id, title: posting.title, description: "", url: publicUrl(companyId, posting.id) };
  const company = posting.company ?? fallbackCompany;
  if (company !== undefined) item.company = company;
  if (posting.city !== undefined) item.location = posting.city;
  if (posting.countryName !== undefined) item.country = posting.countryName;
  if (posting.employmentType !== undefined) item.employmentTypeText = posting.employmentType;
  if (posting.remote) item.workModeText = "remote";
  else if (posting.hybrid) item.workModeText = "hybrid";
  const postedAt = parseDate(posting.releasedAt);
  if (postedAt !== undefined) item.postedAt = postedAt;
  return item;
}

export async function loadSmartRecruitersItems(
  listUrl: string,
  fallbackCompany: string | undefined,
  deps: SmartRecruitersDeps,
): Promise<SmartRecruitersResult> {
  const companyId = companyIdFromUrl(listUrl);
  if (companyId === undefined) throw new FeedParseError("The SmartRecruiters feed URL has no /companies/<id>/postings part.");

  // 1. The list.
  const listed: ListedPosting[] = [];
  let total = Number.POSITIVE_INFINITY;
  while (listed.length < Math.min(total, deps.maxItems)) {
    const url = new URL(listUrl);
    url.searchParams.set("limit", String(Math.min(PAGE_SIZE, deps.maxItems - listed.length)));
    url.searchParams.set("offset", String(listed.length));
    const page = parseListPage(await deps.fetchText(url.toString()));
    total = page.total;
    if (page.postings.length === 0) break;
    listed.push(...page.postings);
  }
  const postings = listed.slice(0, deps.maxItems);

  // 2. What the list entry alone decides.
  const skipped = { role: 0, language: 0, region: 0, known: 0, failed: 0 };
  const wanted: ListedPosting[] = [];
  for (const posting of postings) {
    const reason = deps.skip(posting);
    if (reason === undefined) wanted.push(posting);
    else skipped[reason] += 1;
  }

  const shells = wanted.map((posting) => shellItem(companyId, posting, fallbackCompany));
  const known = shells.length === 0 ? [] : await deps.isKnown(shells);
  const fresh: Array<{ posting: ListedPosting; shell: RawFeedItem }> = [];
  wanted.forEach((posting, index) => {
    const shell = shells[index];
    if (shell === undefined) return;
    if (known[index] === true) skipped.known += 1;
    else fresh.push({ posting, shell });
  });

  // 3. The text of the new ones.
  const batch = fresh.slice(0, MAX_DETAILS_PER_SYNC);
  const detailBase = new URL(listUrl);
  detailBase.search = "";
  const items: RawFeedItem[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batch.length) {
      const entry = batch[next];
      next += 1;
      if (entry === undefined) return;
      try {
        const detail = parseDetail(await deps.fetchText(`${detailBase.toString().replace(/\/+$/, "")}/${encodeURIComponent(entry.posting.id)}`));
        if (detail.description === "") {
          skipped.failed += 1;
          continue;
        }
        const item: RawFeedItem = { ...entry.shell, description: detail.description };
        if (detail.applyUrl !== undefined) item.applyUrl = detail.applyUrl;
        items.push(item);
      } catch {
        skipped.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, batch.length) }, worker));

  return { items, listed: postings.length, skipped, postponed: fresh.length - batch.length };
}

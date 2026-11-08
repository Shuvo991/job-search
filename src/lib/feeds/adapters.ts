/**
 * Turns a downloaded feed (JSON API response or RSS 2.0 / Atom XML) into a flat list of raw items
 * using the field mapping from config/job-feeds.json. Pure functions: no network, no database.
 * Nothing here trusts the content; sanitising and validation happen later in normalize.ts.
 */
import type { FeedFields } from "@/schemas/feed";
import type { ResolvedFeed } from "@/lib/feeds/config";
import { parseXml, xmlToObject, XmlParseError } from "@/lib/feeds/xml";

export class FeedParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FeedParseError";
  }
}

export interface RawFeedItem {
  externalId?: string;
  title: string;
  company?: string;
  /** Canonical link to the posting. */
  url?: string;
  applyUrl?: string;
  /** HTML or plain text, untrusted. */
  description: string;
  location?: string;
  country?: string;
  postedAt?: Date;
  employmentTypeText?: string;
  workModeText?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: string;
}

export interface ParsedFeed {
  items: RawFeedItem[];
  /** Entries that were present but unusable (no title). */
  malformed: number;
  /** How many entries the feed contained before any cap. */
  total: number;
}

// ---------------------------------------------------------------------------
// Path lookup
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_FANOUT = 1000;

function walk(node: unknown, segments: string[], index: number, out: unknown[]): void {
  if (out.length >= MAX_FANOUT) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, segments, index, out);
    return;
  }
  if (index === segments.length) {
    out.push(node);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const key = segments[index];
  if (key === undefined || FORBIDDEN_KEYS.has(key) || !Object.hasOwn(node, key)) return;
  walk((node as Record<string, unknown>)[key], segments, index + 1, out);
}

/** All values found at a dotted path; arrays along the way (or at the end) are flattened. */
export function readPath(source: unknown, path: string): unknown[] {
  const out: unknown[] = [];
  walk(source, path === "" ? [] : path.split("."), 0, out);
  return out;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" && text.trim() !== "" ? text.trim() : undefined;
  }
  return undefined;
}

function asList(path: string | string[] | undefined): string[] {
  return path === undefined ? [] : typeof path === "string" ? [path] : path;
}

/** First non-empty text among the candidate paths. */
export function firstText(source: unknown, path: string | string[] | undefined): string | undefined {
  for (const candidate of asList(path)) {
    for (const value of readPath(source, candidate)) {
      const text = scalarText(value);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function firstNumber(source: unknown, path: string | string[] | undefined): number | undefined {
  const text = firstText(source, path);
  if (text === undefined) return undefined;
  const parsed = Number(text.replace(/[\s,_]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Epoch seconds/milliseconds, ISO 8601 or RFC 822 dates. Anything else gives undefined. */
export function parseFeedDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  let date: Date;
  if (/^\d{9,13}$/.test(value)) {
    const n = Number(value);
    date = new Date(value.length >= 12 ? n : n * 1000);
  } else {
    date = new Date(value);
  }
  const year = date.getUTCFullYear();
  return Number.isNaN(date.getTime()) || year < 1995 || year > 2100 ? undefined : date;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapItem(entry: unknown, fields: FeedFields, feed: ResolvedFeed): RawFeedItem | undefined {
  let title = firstText(entry, fields.title);
  if (title === undefined) return undefined;

  let company = firstText(entry, fields.company);
  if (company === undefined && feed.titleCompanySeparator !== undefined) {
    const at = title.lastIndexOf(feed.titleCompanySeparator);
    if (at > 0) {
      const split = title.slice(at + feed.titleCompanySeparator.length).trim();
      if (split !== "") {
        company = split;
        title = title.slice(0, at).trim();
      }
    }
  }
  company ??= feed.company;

  const item: RawFeedItem = { title, description: firstText(entry, fields.description) ?? "" };
  const assign = <K extends keyof RawFeedItem>(key: K, value: RawFeedItem[K] | undefined) => {
    if (value !== undefined) item[key] = value;
  };
  assign("company", company);
  assign("externalId", firstText(entry, fields.id));
  assign("url", firstText(entry, fields.url));
  assign("applyUrl", firstText(entry, fields.applyUrl));
  assign("location", firstText(entry, fields.location));
  assign("country", firstText(entry, fields.country));
  assign("postedAt", parseFeedDate(firstText(entry, fields.postedAt)));
  assign("employmentTypeText", firstText(entry, fields.employmentType));
  assign("workModeText", firstText(entry, fields.workMode));
  assign("salaryMin", firstNumber(entry, fields.salaryMin));
  assign("salaryMax", firstNumber(entry, fields.salaryMax));
  assign("salaryCurrency", firstText(entry, fields.salaryCurrency));
  assign("salaryPeriod", firstText(entry, fields.salaryPeriod));
  return item;
}

function mapEntries(entries: unknown[], fields: FeedFields, feed: ResolvedFeed, cap: number): ParsedFeed {
  const items: RawFeedItem[] = [];
  let malformed = 0;
  for (const entry of entries.slice(0, cap)) {
    const item = mapItem(entry, fields, feed);
    if (item === undefined) malformed += 1;
    else items.push(item);
  }
  return { items, malformed, total: entries.length };
}

// ---------------------------------------------------------------------------
// REST JSON
// ---------------------------------------------------------------------------

export function parseRestFeed(feed: ResolvedFeed, body: string, cap: number): ParsedFeed {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new FeedParseError("The response is not valid JSON.", { cause });
  }
  const found = readPath(json, feed.itemsPath);
  // A path that points at the array yields its elements; "" on a top-level array does the same.
  const entries = feed.itemsPath === "" && Array.isArray(json) ? json : found;
  if (entries.length === 0 && !hasPath(json, feed.itemsPath)) {
    throw new FeedParseError(
      `The response has no "${feed.itemsPath || "(top level)"}" list. Check itemsPath in config/job-feeds.json.`,
    );
  }
  return mapEntries(entries, feed.fields, feed, cap);
}

function hasPath(json: unknown, path: string): boolean {
  if (path === "") return Array.isArray(json);
  let node: unknown = json;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null || FORBIDDEN_KEYS.has(key) || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return Array.isArray(node);
}

// ---------------------------------------------------------------------------
// RSS 2.0 / Atom
// ---------------------------------------------------------------------------

const RSS_DEFAULTS: FeedFields = {
  id: ["guid", "link"],
  title: "title",
  url: ["link", "guid"],
  description: ["content:encoded", "description"],
  postedAt: ["pubDate", "dc:date"],
};

const ATOM_DEFAULTS: FeedFields = {
  id: "id",
  title: "title",
  url: ["link.@href", "id"],
  description: ["content", "summary"],
  postedAt: ["published", "updated"],
};

function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export function parseRssFeed(feed: ResolvedFeed, body: string, cap: number): ParsedFeed {
  let tree: unknown;
  let rootName: string;
  try {
    const root = parseXml(body);
    rootName = root.name;
    tree = xmlToObject(root);
  } catch (cause) {
    if (cause instanceof XmlParseError) throw new FeedParseError(`The feed is not valid XML: ${cause.message}`, { cause });
    throw cause;
  }

  let entries: unknown[];
  let defaults: FeedFields;
  if (rootName === "rss" || rootName === "rdf:RDF") {
    const container = rootName === "rss" ? readPath(tree, "channel")[0] : tree;
    entries = asArray(typeof container === "object" && container !== null ? (container as Record<string, unknown>)["item"] : undefined);
    defaults = RSS_DEFAULTS;
  } else if (rootName === "feed") {
    entries = asArray(typeof tree === "object" && tree !== null ? (tree as Record<string, unknown>)["entry"] : undefined);
    defaults = ATOM_DEFAULTS;
  } else {
    throw new FeedParseError(`Expected an RSS or Atom feed but found <${rootName}>.`);
  }

  // Fields given in the config replace the defaults key by key.
  const configured = Object.fromEntries(Object.entries(feed.fields).filter(([, value]) => value !== undefined));
  const fields: FeedFields = { ...defaults, ...configured };
  return mapEntries(entries, fields, feed, cap);
}

export function parseFeedBody(feed: ResolvedFeed, body: string, cap: number): ParsedFeed {
  return feed.type === "rest-json" ? parseRestFeed(feed, body, cap) : parseRssFeed(feed, body, cap);
}

/**
 * Loads config/job-feeds.json, validates it and expands feeds that have `instances` (one feed per
 * company / query variant) into a flat list of ready-to-run feeds.
 */
import boardsJson from "../../../config/company-boards.json";
import feedsJson from "../../../config/job-feeds.json";
import {
  feedConfigSchema,
  type FeedConfig,
  type FeedDefinition,
  type FeedFields,
  type FeedSettings,
} from "@/schemas/feed";
import { mergeCompanyBoards } from "@/lib/feeds/company-boards";
import { stripCommentKeys } from "@/lib/strip-comments";
import { parseWith } from "@/lib/validation";

export type QueryParams = Record<string, string | number | boolean>;

export interface ResolvedFeed {
  /** Unique id: "jobicy", or "teamtailor:tibber" for an instance. */
  id: string;
  /** Display name and the `sourceName` stored on every job from this feed. */
  name: string;
  type: FeedDefinition["type"];
  enabled: boolean;
  /** Final https URL with {placeholders} filled in (query parameters are added at fetch time). */
  url: string;
  query: QueryParams;
  minIntervalMinutes: number;
  /** Per-feed override of settings.userAgent. */
  userAgent: string | undefined;
  /** The source leaves the location empty on jobs open to candidates from anywhere. */
  worldwideWhenNoLocation: boolean;
  attribution: string | undefined;
  terms: string | undefined;
  /** Hosts this feed may contact (its own host plus allowed redirect targets). */
  allowedHosts: string[];
  defaults: FeedDefinition["defaults"];
  /** Employer name supplied by the config (an instance's `company`, or defaults.company). */
  company: string | undefined;
  fields: FeedFields;
  /** rest-json only */
  itemsPath: string;
  /** rest-json only: a source read by its own multi-request reader instead of one download. */
  adapter?: "smartrecruiters" | undefined;
  /** rss only */
  titleCompanySeparator: string | undefined;
}

export class FeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedConfigError";
  }
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function fillPlaceholders(url: string, vars: Record<string, string>, feedId: string): string {
  return url.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new FeedConfigError(`Feed "${feedId}": the URL uses {${name}} but an instance does not define it.`);
    }
    return encodeURIComponent(value);
  });
}

function hostOf(url: string, feedId: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new FeedConfigError(`Feed "${feedId}": "${url}" is not a valid URL.`);
  }
}

function resolveFeed(feed: FeedDefinition): ResolvedFeed[] {
  const hasPlaceholders = /\{[A-Za-z0-9_]+\}/.test(feed.url);
  if (hasPlaceholders && (feed.instances === undefined || feed.instances.length === 0)) {
    throw new FeedConfigError(`Feed "${feed.id}": the URL has a {placeholder} but no instances are configured.`);
  }

  const build = (
    id: string,
    name: string,
    enabled: boolean,
    url: string,
    query: QueryParams,
    company: string | undefined,
    extraHosts: string[],
  ): ResolvedFeed => ({
    id,
    name,
    type: feed.type,
    enabled,
    url,
    query,
    minIntervalMinutes: feed.minIntervalMinutes,
    userAgent: feed.userAgent,
    worldwideWhenNoLocation: feed.worldwideWhenNoLocation,
    attribution: feed.attribution,
    terms: feed.terms,
    allowedHosts: [...new Set([hostOf(url, id), ...(feed.allowedHosts ?? []), ...extraHosts].map((h) => h.toLowerCase()))],
    defaults: feed.defaults,
    company: company ?? feed.defaults.company,
    fields: feed.fields,
    itemsPath: feed.type === "rest-json" ? feed.itemsPath : "",
    adapter: feed.type === "rest-json" ? feed.adapter : undefined,
    titleCompanySeparator: feed.type === "rss" ? feed.titleCompanySeparator : undefined,
  });

  if (feed.instances === undefined || feed.instances.length === 0) {
    return [build(feed.id, feed.name, feed.enabled, feed.url, feed.query, undefined, [])];
  }

  return feed.instances.map((instance) =>
    build(
      `${feed.id}:${instance.id}`,
      instance.name ?? `${feed.name} – ${instance.company ?? instance.id}`,
      feed.enabled && instance.enabled,
      fillPlaceholders(feed.url, instance.vars, feed.id),
      { ...feed.query, ...(instance.query ?? {}) },
      instance.company,
      instance.allowedHosts ?? [],
    ),
  );
}

export interface LoadedFeedConfig {
  settings: FeedSettings;
  feeds: ResolvedFeed[];
}

/** Validate raw JSON and expand it. Throws FeedConfigError / ValidationError with a clear message. */
export function parseFeedConfig(raw: unknown): LoadedFeedConfig {
  const config: FeedConfig = parseWith(feedConfigSchema, stripCommentKeys(raw));
  const feeds = config.feeds.flatMap(resolveFeed);

  const seen = new Set<string>();
  for (const feed of feeds) {
    if (seen.has(feed.id)) throw new FeedConfigError(`Duplicate feed id "${feed.id}" in config/job-feeds.json.`);
    seen.add(feed.id);
  }
  return { settings: config.settings, feeds };
}

let cached: LoadedFeedConfig | undefined;

/** config/job-feeds.json plus the company boards in config/company-boards.json, validated once per process. */
export function getFeedConfig(): LoadedFeedConfig {
  cached ??= parseFeedConfig(mergeCompanyBoards(feedsJson, boardsJson));
  return cached;
}

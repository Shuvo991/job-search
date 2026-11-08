/**
 * Feed ingestion pipeline: fetch -> parse -> sanitise -> English-only gate -> role check ->
 * de-duplicate -> extract skills -> store, one feed at a time, with a log row per feed.
 *
 * Failures are contained: one broken feed is logged and reported without stopping the others, and
 * a bad item never stops the rest of its feed. Rate limiting is per feed (see sync-log.ts), and
 * only one sync runs at a time. There are no AI calls anywhere in this path.
 */
import { ConflictError, ValidationError } from "@/lib/errors";
import { parseFeedBody, FeedParseError, type RawFeedItem } from "@/lib/feeds/adapters";
import { getFeedConfig, type LoadedFeedConfig, type ResolvedFeed } from "@/lib/feeds/config";
import { fetchFeedText, FeedFetchError, type FetchLike } from "@/lib/feeds/fetcher";
import { buildFeedJob, prepareItem, roleOf, workModeFor } from "@/lib/feeds/normalize";
import { latestRunsByFeed, nextAllowedAt, recordSyncRun, type SyncLogRow } from "@/lib/feeds/sync-log";
import { getGeoFilter, type GeoFilter } from "@/lib/geo-filter";
import { getGatekeeper, type Gatekeeper } from "@/lib/language-filter";
import type { FeedStatus, FeedSyncResult, FilteredCounts, SyncSummary, SyncTotals } from "@/lib/feeds/types";
import { computeFeedDedupeHash } from "@/lib/jobs/dedupe";
import { findExistingDedupeHashes, insertImportedJob } from "@/lib/jobs/repository";

export type { FeedRunStatus, FeedStatus, FeedSyncResult, FilteredCounts, SyncSummary, SyncTotals } from "@/lib/feeds/types";

export interface SyncOptions {
  /** Feed ids to sync; default is every enabled feed. */
  feedIds?: string[] | undefined;
  now?: () => Date;
  config?: LoadedFeedConfig;
  fetchImpl?: FetchLike;
  gatekeeper?: Gatekeeper;
  geoFilter?: GeoFilter;
}

const lockHolder = globalThis as unknown as { __feedSyncRunning?: boolean };

export function isSyncRunning(): boolean {
  return lockHolder.__feedSyncRunning === true;
}

const emptyFiltered = (): FilteredCounts => ({ language: 0, requiredLanguage: 0, role: 0, region: 0 });

/** Run `task` over `values` with at most `limit` in flight, keeping results in input order. */
async function mapWithConcurrency<T, R>(values: T[], limit: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function describeError(error: unknown): string {
  if (error instanceof FeedFetchError || error instanceof FeedParseError) return error.message;
  if (error instanceof ValidationError) return "The feed configuration is invalid.";
  return "Unexpected error while syncing this feed; see the server log.";
}

function buildRequestUrl(feed: ResolvedFeed): string {
  const url = new URL(feed.url);
  for (const [key, value] of Object.entries(feed.query)) url.searchParams.set(key, String(value));
  return url.toString();
}

interface FeedContext {
  config: LoadedFeedConfig;
  fetchImpl: FetchLike | undefined;
  gatekeeper: Gatekeeper;
  geoFilter: GeoFilter;
  now: () => Date;
}

/** Everything that happens to one feed's items after they have been downloaded and parsed. */
async function processItems(
  feed: ResolvedFeed,
  rawItems: RawFeedItem[],
  context: FeedContext,
): Promise<Pick<FeedSyncResult, "imported" | "duplicates" | "invalid" | "filtered">> {
  const filtered = emptyFiltered();
  let invalid = 0;
  let duplicates = 0;
  let imported = 0;

  // Phase 1: sanitise and fingerprint everything (cheap), then ask the database once which ads we
  // already have so detection and skill extraction are only spent on new ones.
  const prepared = [];
  const now = context.now();
  for (const raw of rawItems) {
    const result = prepareItem(raw, now);
    if (!result.ok) {
      invalid += 1;
      continue;
    }
    prepared.push({
      item: result.item,
      hash: computeFeedDedupeHash({
        company: result.item.company,
        title: result.item.title,
        externalUrl: result.item.externalUrl,
      }),
    });
  }

  const known = await findExistingDedupeHashes(prepared.map((entry) => entry.hash));
  const seenThisRun = new Set<string>();

  for (const { item, hash } of prepared) {
    if (known.has(hash) || seenThisRun.has(hash)) {
      duplicates += 1;
      continue;
    }
    seenThisRun.add(hash);

    // Step A + B: English-only gatekeeper.
    const verdict = context.gatekeeper.evaluate({
      title: item.title,
      company: item.company,
      description: item.description,
    });
    if (!verdict.accepted) {
      if (verdict.stage === "language") filtered.language += 1;
      else filtered.requiredLanguage += 1;
      continue;
    }

    const role = roleOf(item);
    if (role === undefined) {
      filtered.role += 1;
      continue;
    }

    // Location gate: European jobs, plus remote jobs that anyone in the world may apply for.
    const geo = context.geoFilter.evaluate({
      workMode: workModeFor(item, feed),
      location: item.location,
      country: item.country,
      defaultCountry: feed.defaults.country,
      description: item.description,
      worldwideWhenNoLocation: feed.worldwideWhenNoLocation,
    });
    if (!geo.accepted) {
      filtered.region += 1;
      continue;
    }

    let job;
    try {
      job = buildFeedJob(item, role, feed);
    } catch (error) {
      if (error instanceof ValidationError) {
        invalid += 1;
        continue;
      }
      throw error;
    }

    const outcome = await insertImportedJob(job, hash);
    if (outcome === "created") imported += 1;
    else duplicates += 1;
  }

  return { imported, duplicates, invalid, filtered };
}

async function syncOneFeed(feed: ResolvedFeed, context: FeedContext): Promise<FeedSyncResult> {
  const { settings } = context.config;
  const started = context.now();
  const base: FeedSyncResult = {
    feedId: feed.id,
    feedName: feed.name,
    status: "success",
    fetched: 0,
    imported: 0,
    duplicates: 0,
    invalid: 0,
    filtered: emptyFiltered(),
    durationMs: 0,
  };

  let result: FeedSyncResult;
  try {
    const body = await fetchFeedText(buildRequestUrl(feed), {
      userAgent: feed.userAgent ?? settings.userAgent,
      timeoutMs: settings.requestTimeoutMs,
      maxBytes: settings.maxResponseBytes,
      maxRedirects: settings.maxRedirects,
      allowedHosts: feed.allowedHosts,
      accept: feed.type === "rss" ? "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" : "application/json",
      ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    });
    const parsed = parseFeedBody(feed, body, settings.maxItemsPerFeed);
    const outcome = await processItems(feed, parsed.items, context);
    result = {
      ...base,
      fetched: parsed.items.length + parsed.malformed,
      ...outcome,
      invalid: outcome.invalid + parsed.malformed,
    };
  } catch (error) {
    if (!(error instanceof FeedFetchError || error instanceof FeedParseError)) {
      console.error(`[feed-sync] ${feed.id} failed`, error);
    }
    result = { ...base, status: "error", error: describeError(error) };
  }

  const finished = context.now();
  result.durationMs = Math.max(0, finished.getTime() - started.getTime());

  try {
    await recordSyncRun({
      feedId: feed.id,
      feedName: feed.name,
      status: result.status === "success" ? "SUCCESS" : "ERROR",
      startedAt: started,
      finishedAt: finished,
      durationMs: result.durationMs,
      fetched: result.fetched,
      imported: result.imported,
      duplicates: result.duplicates,
      filtered: result.filtered.language + result.filtered.requiredLanguage + result.filtered.role + result.filtered.region,
      invalid: result.invalid,
      error: result.error ?? null,
    });
  } catch (error) {
    // A log failure must not turn a good sync into a failed one.
    console.error(`[feed-sync] could not write the sync log for ${feed.id}`, error);
  }
  return result;
}

function summarise(feeds: FeedSyncResult[], startedAt: Date, finishedAt: Date): SyncSummary {
  const totals: SyncTotals = {
    fetched: 0,
    imported: 0,
    duplicates: 0,
    invalid: 0,
    filteredOut: 0,
    filtered: emptyFiltered(),
    feedsSynced: 0,
    feedsFailed: 0,
    feedsSkipped: 0,
  };
  for (const feed of feeds) {
    if (feed.status === "success") totals.feedsSynced += 1;
    else if (feed.status === "error") totals.feedsFailed += 1;
    else totals.feedsSkipped += 1;
    totals.fetched += feed.fetched;
    totals.imported += feed.imported;
    totals.duplicates += feed.duplicates;
    totals.invalid += feed.invalid;
    totals.filtered.language += feed.filtered.language;
    totals.filtered.requiredLanguage += feed.filtered.requiredLanguage;
    totals.filtered.role += feed.filtered.role;
    totals.filtered.region += feed.filtered.region;
  }
  totals.filteredOut =
    totals.filtered.language + totals.filtered.requiredLanguage + totals.filtered.role + totals.filtered.region;
  return { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), feeds, totals };
}

/**
 * Sync the selected feeds (default: all enabled ones). Feeds still inside their cooldown are
 * reported as "rate_limited" instead of being fetched. Throws ConflictError (409) if a sync is
 * already running. Unknown feed ids are the caller's job to reject (see the route).
 */
export async function syncFeeds(options: SyncOptions = {}): Promise<SyncSummary> {
  if (lockHolder.__feedSyncRunning === true) {
    throw new ConflictError("A feed sync is already running. Wait for it to finish.");
  }
  lockHolder.__feedSyncRunning = true;

  try {
    const now = options.now ?? (() => new Date());
    const config = options.config ?? getFeedConfig();
    const context: FeedContext = {
      config,
      fetchImpl: options.fetchImpl,
      gatekeeper: options.gatekeeper ?? getGatekeeper(),
      geoFilter: options.geoFilter ?? getGeoFilter(),
      now,
    };
    const startedAt = now();

    const wanted = options.feedIds === undefined ? undefined : new Set(options.feedIds);
    const selected = config.feeds.filter((feed) => (wanted === undefined ? feed.enabled : wanted.has(feed.id)));

    const lastRuns: Map<string, SyncLogRow> = await latestRunsByFeed(selected.map((feed) => feed.id));

    const runnable: ResolvedFeed[] = [];
    const results = new Map<string, FeedSyncResult>();
    for (const feed of selected) {
      const skipped = (status: "disabled" | "rate_limited", retryAfterSeconds?: number): FeedSyncResult => ({
        feedId: feed.id,
        feedName: feed.name,
        status,
        fetched: 0,
        imported: 0,
        duplicates: 0,
        invalid: 0,
        filtered: emptyFiltered(),
        durationMs: 0,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });

      if (!feed.enabled) {
        results.set(feed.id, skipped("disabled"));
        continue;
      }
      const allowedAt = nextAllowedAt(
        lastRuns.get(feed.id),
        feed.minIntervalMinutes,
        config.settings.failureBackoffMinutes,
        now(),
      );
      if (allowedAt !== null) {
        results.set(feed.id, skipped("rate_limited", Math.ceil((allowedAt.getTime() - now().getTime()) / 1000)));
        continue;
      }
      runnable.push(feed);
    }

    const ran = await mapWithConcurrency(runnable, config.settings.concurrency, (feed) => syncOneFeed(feed, context));
    for (const result of ran) results.set(result.feedId, result);

    // Report in config order so the UI table is stable.
    const ordered = selected.map((feed) => results.get(feed.id)).filter((r): r is FeedSyncResult => r !== undefined);
    return summarise(ordered, startedAt, now());
  } finally {
    lockHolder.__feedSyncRunning = false;
  }
}

/** Feed list with last-run info, for the status panel. */
export async function getFeedStatuses(options: { now?: () => Date; config?: LoadedFeedConfig } = {}): Promise<FeedStatus[]> {
  const now = (options.now ?? (() => new Date()))();
  const config = options.config ?? getFeedConfig();
  const lastRuns = await latestRunsByFeed(config.feeds.map((feed) => feed.id));

  return config.feeds.map((feed) => {
    const last = lastRuns.get(feed.id);
    const allowedAt = nextAllowedAt(last, feed.minIntervalMinutes, config.settings.failureBackoffMinutes, now);
    return {
      id: feed.id,
      name: feed.name,
      type: feed.type,
      enabled: feed.enabled,
      attribution: feed.attribution ?? null,
      minIntervalMinutes: feed.minIntervalMinutes,
      lastRun: last
        ? {
            status: last.status,
            finishedAt: last.finishedAt.toISOString(),
            fetched: last.fetched,
            imported: last.imported,
            duplicates: last.duplicates,
            filtered: last.filtered,
            invalid: last.invalid,
            error: last.error,
          }
        : null,
      nextAllowedAt: allowedAt === null ? null : allowedAt.toISOString(),
    };
  });
}

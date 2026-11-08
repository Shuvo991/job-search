/** Result shapes shared by the sync pipeline, the API and the UI (no server-only imports here). */

export interface FilteredCounts {
  /** Not English (or too short to tell). */
  language: number;
  /** English text, but it requires Swedish, German or another language. */
  requiredLanguage: number;
  /** Not one of the roles this board lists (e.g. sales, design). */
  role: number;
}

export type FeedRunStatus = "success" | "error" | "rate_limited" | "disabled";

export interface FeedSyncResult {
  feedId: string;
  feedName: string;
  status: FeedRunStatus;
  /** Items the feed returned (after the per-feed cap). */
  fetched: number;
  imported: number;
  duplicates: number;
  /** Items dropped because they were unusable (no title, company or link, or failed validation). */
  invalid: number;
  filtered: FilteredCounts;
  durationMs: number;
  /** Plain-language explanation when status is "error". */
  error?: string;
  /** When status is "rate_limited": seconds until this feed may be synced again. */
  retryAfterSeconds?: number;
}

export interface SyncTotals {
  fetched: number;
  imported: number;
  duplicates: number;
  invalid: number;
  filteredOut: number;
  filtered: FilteredCounts;
  feedsSynced: number;
  feedsFailed: number;
  feedsSkipped: number;
}

export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  feeds: FeedSyncResult[];
  totals: SyncTotals;
}

export interface FeedStatus {
  id: string;
  name: string;
  type: "rest-json" | "rss";
  enabled: boolean;
  attribution: string | null;
  minIntervalMinutes: number;
  lastRun: {
    status: "SUCCESS" | "ERROR";
    finishedAt: string;
    fetched: number;
    imported: number;
    duplicates: number;
    filtered: number;
    invalid: number;
    error: string | null;
  } | null;
  /** ISO time when the feed may be synced again, or null if it can be synced now. */
  nextAllowedAt: string | null;
}


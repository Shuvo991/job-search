/**
 * Background sync while the app is running. Started once from src/instrumentation.ts when the
 * Node.js server boots: a first sync shortly after start-up, then one every few hours.
 *
 * It calls the very same syncFeeds() as the button, so per-feed cooldowns apply: restarting the
 * app often, or an overlapping manual sync, never causes extra requests to a source.
 * Nothing runs while the app is closed.
 */
import { ConflictError } from "@/lib/errors";
import { syncFeeds } from "@/lib/feed-ingestor";
import { getFeedConfig } from "@/lib/feeds/config";
import type { SyncSummary } from "@/lib/feeds/types";

export interface AutoSyncLog {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface TimerLike {
  unref?: () => unknown;
}

export interface AutoSyncTimers {
  setTimeout(callback: () => void, ms: number): TimerLike;
  setInterval(callback: () => void, ms: number): TimerLike;
  clearTimeout(timer: TimerLike): void;
  clearInterval(timer: TimerLike): void;
}

const realTimers: AutoSyncTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const consoleLog: AutoSyncLog = {
  info: (message) => console.info(message),
  error: (message, error) => console.error(message, error),
};

export function describeSummary(summary: SyncSummary): string {
  const { totals } = summary;
  if (totals.feedsSynced === 0 && totals.feedsFailed === 0) return "[auto-sync] every feed is still in its cooldown; nothing to do";
  return (
    `[auto-sync] imported ${totals.imported} new, filtered out ${totals.filteredOut}, ` +
    `${totals.duplicates} already had, ${totals.feedsFailed} feed(s) failed`
  );
}

/** One run. Never throws: a failed background sync must not take the server down. */
export async function runAutoSyncOnce(
  run: () => Promise<SyncSummary>,
  log: AutoSyncLog = consoleLog,
): Promise<void> {
  try {
    log.info(describeSummary(await run()));
  } catch (error) {
    if (error instanceof ConflictError) return; // a sync (e.g. the button) is already running
    log.error("[auto-sync] sync failed", error);
  }
}

export interface AutoSyncOptions {
  startupDelayMs: number;
  intervalMs: number;
  run?: () => Promise<SyncSummary>;
  log?: AutoSyncLog;
  timers?: AutoSyncTimers;
}

export interface AutoSyncHandle {
  stop(): void;
}

export function startAutoSync(options: AutoSyncOptions): AutoSyncHandle {
  const run = options.run ?? (() => syncFeeds());
  const timers = options.timers ?? realTimers;
  const log = options.log ?? consoleLog;

  let interval: TimerLike | undefined;
  const first = timers.setTimeout(() => {
    void runAutoSyncOnce(run, log);
    interval = timers.setInterval(() => void runAutoSyncOnce(run, log), options.intervalMs);
    interval.unref?.();
  }, options.startupDelayMs);
  first.unref?.(); // never keep the process alive just for this

  return {
    stop() {
      timers.clearTimeout(first);
      if (interval !== undefined) timers.clearInterval(interval);
    },
  };
}

const holder = globalThis as unknown as { __autoSyncHandle?: AutoSyncHandle };

/**
 * Start the scheduler from config/job-feeds.json (once per server process, even if the dev
 * server reloads modules). Returns undefined when disabled or when the config is unusable.
 */
export function startAutoSyncFromConfig(log: AutoSyncLog = consoleLog): AutoSyncHandle | undefined {
  if (holder.__autoSyncHandle !== undefined) return holder.__autoSyncHandle;
  if (process.env["AUTO_SYNC"] === "off") return undefined;

  try {
    const { autoSync } = getFeedConfig().settings;
    if (!autoSync.enabled) return undefined;
    holder.__autoSyncHandle = startAutoSync({
      startupDelayMs: autoSync.startupDelaySeconds * 1000,
      intervalMs: autoSync.intervalMinutes * 60_000,
      log,
    });
    log.info(
      `[auto-sync] on: first sync in ${autoSync.startupDelaySeconds}s, then every ${autoSync.intervalMinutes} min while the app runs`,
    );
    return holder.__autoSyncHandle;
  } catch (error) {
    log.error("[auto-sync] not started: config/job-feeds.json is invalid", error);
    return undefined;
  }
}

/** Test helper: forget the process-wide handle. */
export function resetAutoSyncForTests(): void {
  holder.__autoSyncHandle?.stop();
  delete holder.__autoSyncHandle;
}

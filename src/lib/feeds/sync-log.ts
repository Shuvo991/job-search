/**
 * Per-feed sync history. Besides being the error log shown in the UI, it is what makes rate
 * limiting survive a server restart: the cooldown is computed from the last logged run.
 */
import { prisma } from "@/lib/db";

export type SyncStatus = "SUCCESS" | "ERROR";

export interface SyncLogEntry {
  feedId: string;
  feedName: string;
  status: SyncStatus;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  fetched: number;
  imported: number;
  duplicates: number;
  filtered: number;
  invalid: number;
  error: string | null;
}

export interface SyncLogRow extends SyncLogEntry {
  id: string;
}

const ERROR_MAX_CHARS = 500;

export async function recordSyncRun(entry: SyncLogEntry): Promise<void> {
  await prisma.feedSyncLog.create({
    data: { ...entry, error: entry.error === null ? null : entry.error.slice(0, ERROR_MAX_CHARS) },
  });
}

function toRow(row: {
  id: string;
  feedId: string;
  feedName: string;
  status: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  fetched: number;
  imported: number;
  duplicates: number;
  filtered: number;
  invalid: number;
  error: string | null;
}): SyncLogRow {
  return { ...row, status: row.status === "SUCCESS" ? "SUCCESS" : "ERROR" };
}

/** The most recent logged run of each feed (feeds never synced are absent from the map). */
export async function latestRunsByFeed(feedIds: string[]): Promise<Map<string, SyncLogRow>> {
  const latest = new Map<string, SyncLogRow>();
  for (const feedId of feedIds) {
    const row = await prisma.feedSyncLog.findFirst({ where: { feedId }, orderBy: { finishedAt: "desc" } });
    if (row) latest.set(feedId, toRow(row));
  }
  return latest;
}

/** When this feed may be synced again, or null if it may be synced now. */
export function nextAllowedAt(
  last: Pick<SyncLogRow, "status" | "finishedAt"> | undefined,
  minIntervalMinutes: number,
  failureBackoffMinutes: number,
  now: Date,
): Date | null {
  if (last === undefined) return null;
  const waitMinutes = last.status === "SUCCESS" ? minIntervalMinutes : failureBackoffMinutes;
  const allowed = new Date(last.finishedAt.getTime() + waitMinutes * 60_000);
  return allowed.getTime() > now.getTime() ? allowed : null;
}

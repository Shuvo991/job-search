import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@/lib/errors";
import {
  describeSummary,
  resetAutoSyncForTests,
  runAutoSyncOnce,
  startAutoSync,
  startAutoSyncFromConfig,
  type AutoSyncLog,
  type AutoSyncTimers,
  type TimerLike,
} from "@/lib/auto-sync";
import type { SyncSummary } from "@/lib/feeds/types";

function summary(overrides: Partial<SyncSummary["totals"]> = {}): SyncSummary {
  return {
    startedAt: "2026-11-08T10:00:00.000Z",
    finishedAt: "2026-11-08T10:00:05.000Z",
    feeds: [],
    totals: {
      fetched: 10,
      imported: 3,
      duplicates: 2,
      invalid: 0,
      filteredOut: 5,
      filtered: { language: 3, requiredLanguage: 1, role: 1 },
      feedsSynced: 2,
      feedsFailed: 0,
      feedsSkipped: 0,
      ...overrides,
    },
  };
}

function recorder() {
  const lines: string[] = [];
  const errors: string[] = [];
  const log: AutoSyncLog = { info: (m) => void lines.push(m), error: (m) => void errors.push(m) };
  return { lines, errors, log };
}

/** Timers that only record what was scheduled; the test fires them by hand. */
function fakeTimers() {
  const scheduled: Array<{ kind: "timeout" | "interval"; ms: number; callback: () => void; cleared: boolean }> = [];
  const timers: AutoSyncTimers = {
    setTimeout: (callback, ms) => {
      const entry = { kind: "timeout" as const, ms, callback, cleared: false };
      scheduled.push(entry);
      return Object.assign(entry, { unref: () => undefined }) as TimerLike;
    },
    setInterval: (callback, ms) => {
      const entry = { kind: "interval" as const, ms, callback, cleared: false };
      scheduled.push(entry);
      return Object.assign(entry, { unref: () => undefined }) as TimerLike;
    },
    clearTimeout: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    clearInterval: (timer) => void ((timer as { cleared: boolean }).cleared = true),
  };
  return { scheduled, timers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetAutoSyncForTests();
});
afterEach(() => {
  resetAutoSyncForTests();
  delete process.env["AUTO_SYNC"];
  vi.restoreAllMocks();
});

describe("runAutoSyncOnce", () => {
  it("logs what was imported", async () => {
    const { lines, log } = recorder();
    await runAutoSyncOnce(async () => summary(), log);
    expect(lines).toEqual(["[auto-sync] imported 3 new, filtered out 5, 2 already had, 0 feed(s) failed"]);
  });

  it("says so when every feed is cooling down", () => {
    expect(describeSummary(summary({ feedsSynced: 0, feedsFailed: 0, feedsSkipped: 2 }))).toMatch(/cooldown/);
  });

  it("stays quiet when a sync is already running", async () => {
    const { lines, errors, log } = recorder();
    await runAutoSyncOnce(async () => Promise.reject(new ConflictError("running")), log);
    expect([lines, errors]).toEqual([[], []]);
  });

  it("logs unexpected failures instead of throwing", async () => {
    const { errors, log } = recorder();
    await expect(runAutoSyncOnce(async () => Promise.reject(new Error("db down")), log)).resolves.toBeUndefined();
    expect(errors).toEqual(["[auto-sync] sync failed"]);
  });
});

describe("startAutoSync", () => {
  it("waits for the start-up delay, syncs, then repeats on the interval", async () => {
    const { scheduled, timers } = fakeTimers();
    const run = vi.fn(async () => summary());
    startAutoSync({ startupDelayMs: 30_000, intervalMs: 180 * 60_000, run, log: recorder().log, timers });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ kind: "timeout", ms: 30_000 });
    expect(run).not.toHaveBeenCalled();

    scheduled[0]?.callback();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduled[1]).toMatchObject({ kind: "interval", ms: 180 * 60_000 });

    scheduled[1]?.callback();
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("can be stopped before and after it starts repeating", async () => {
    const { scheduled, timers } = fakeTimers();
    const handle = startAutoSync({ startupDelayMs: 1, intervalMs: 1, run: async () => summary(), log: recorder().log, timers });
    handle.stop();
    expect(scheduled[0]?.cleared).toBe(true);

    const second = fakeTimers();
    const again = startAutoSync({ startupDelayMs: 1, intervalMs: 1, run: async () => summary(), log: recorder().log, timers: second.timers });
    second.scheduled[0]?.callback();
    again.stop();
    expect(second.scheduled.every((entry) => entry.cleared)).toBe(true);
  });
});

describe("startAutoSyncFromConfig", () => {
  it("starts once from config/job-feeds.json and reuses the handle", () => {
    const { lines, log } = recorder();
    const first = startAutoSyncFromConfig(log);
    const second = startAutoSyncFromConfig(log);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/first sync in 30s, then every 180 min/);
  });

  it("does nothing when AUTO_SYNC=off", () => {
    process.env["AUTO_SYNC"] = "off";
    const { lines, log } = recorder();
    expect(startAutoSyncFromConfig(log)).toBeUndefined();
    expect(lines).toEqual([]);
  });
});

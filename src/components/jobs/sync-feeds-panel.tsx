"use client";

import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState } from "react";
import { hintClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import type { FeedStatus, FeedSyncResult, SyncSummary } from "@/lib/feeds/types";

type Phase = "idle" | "syncing" | "done" | "failed";

interface ApiError {
  error?: { message?: string };
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

function resultLabel(feed: FeedSyncResult): string {
  switch (feed.status) {
    case "success":
      return "Synced";
    case "error":
      return "Failed";
    case "rate_limited":
      return `Wait ${waitText(feed.retryAfterSeconds ?? 0)}`;
    case "disabled":
      return "Off";
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function headline(summary: SyncSummary): string {
  const { totals } = summary;
  if (totals.feedsSynced === 0 && totals.feedsFailed === 0) {
    return "Nothing new to fetch: every feed was synced recently (or is switched off). Each feed's last result is listed under Sources and history.";
  }
  const parts = [`Imported ${plural(totals.imported, "new job")}`];
  if (totals.filteredOut > 0) {
    parts.push(
      `filtered out ${totals.filteredOut} (${totals.filtered.language} not English, ${totals.filtered.requiredLanguage} requiring another language, ${totals.filtered.role} other roles, ${totals.filtered.region} outside Europe or not open worldwide)`,
    );
  }
  if (totals.duplicates > 0) parts.push(`${totals.duplicates} already on the board`);
  if (totals.feedsFailed > 0) parts.push(`${plural(totals.feedsFailed, "feed")} failed`);
  return `${parts.join("; ")}.`;
}

function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SyncFeedsPanel() {
  const router = useRouter();
  const headingId = useId();
  const regionId = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [statuses, setStatuses] = useState<FeedStatus[] | null>(null);
  const [message, setMessage] = useState<string>("");
  const [autoSync, setAutoSync] = useState<{ enabled: boolean; intervalMinutes: number } | null>(null);
  const busy = useRef(false);

  const loadStatuses = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs/sync", { cache: "no-store" });
      if (response.ok) {
        const body = (await response.json()) as {
          feeds: FeedStatus[];
          autoSync?: { enabled: boolean; intervalMinutes: number };
        };
        setStatuses(body.feeds);
        if (body.autoSync) setAutoSync(body.autoSync);
      }
    } catch {
      // The status list is a convenience; the sync result table is what matters.
    }
  }, []);

  async function runSync() {
    if (busy.current) return;
    busy.current = true;
    setOpen(true);
    setPhase("syncing");
    setMessage("Syncing feeds. This can take up to a minute.");
    try {
      const response = await fetch("/api/jobs/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiError;
        setPhase("failed");
        setMessage(body.error?.message ?? `The sync failed (HTTP ${response.status}).`);
        return;
      }
      const result = (await response.json()) as SyncSummary;
      // When every feed was still cooling down the run holds only zeros; keep the last real result visible.
      if (result.totals.feedsSynced > 0 || result.totals.feedsFailed > 0) setSummary(result);
      setPhase("done");
      setMessage(headline(result));
      await loadStatuses();
      router.refresh();
    } catch {
      setPhase("failed");
      setMessage("Could not reach the server. Is the app still running?");
    } finally {
      busy.current = false;
    }
  }

  function togglePanel() {
    const next = !open;
    setOpen(next);
    if (next && statuses === null) void loadStatuses();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          aria-disabled={phase === "syncing"}
          onClick={() => void runSync()}
        >
          {phase === "syncing" ? "Syncing…" : "Sync English jobs"}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={togglePanel}
        >
          {open ? "Hide feed status" : "Feed status"}
        </button>
      </div>

      {/* Always rendered so screen readers announce changes to it. */}
      <p role={phase === "failed" ? "alert" : "status"} className="text-base text-neutral-900">
        {message}
      </p>

      <section
        id={regionId}
        aria-labelledby={headingId}
        hidden={!open}
        className="space-y-4 rounded-lg border border-neutral-400 bg-white p-4"
      >
        <h2 id={headingId} className="text-lg font-semibold">
          Job feeds
        </h2>

        {summary ? (
          <div className="space-y-2">
            <h3 className="text-base font-semibold">Last sync</h3>
            <div
              role="region"
              aria-label="Last sync results, scrollable table"
              tabIndex={0}
              className="overflow-x-auto rounded-md border border-neutral-300"
            >
              <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
                <caption className="sr-only">Result of the last sync, one row per feed</caption>
                <thead className="bg-neutral-100">
                  <tr>
                    <th scope="col" className="p-2 font-semibold">Feed</th>
                    <th scope="col" className="p-2 font-semibold">Result</th>
                    <th scope="col" className="p-2 text-right font-semibold">Found</th>
                    <th scope="col" className="p-2 text-right font-semibold">Imported</th>
                    <th scope="col" className="p-2 text-right font-semibold">Already had</th>
                    <th scope="col" className="p-2 text-right font-semibold">Not English</th>
                    <th scope="col" className="p-2 text-right font-semibold">Needs another language</th>
                    <th scope="col" className="p-2 text-right font-semibold">Other roles</th>
                    <th scope="col" className="p-2 text-right font-semibold">Outside Europe / not worldwide</th>
                    <th scope="col" className="p-2 text-right font-semibold">Unusable</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.feeds.map((feed) => (
                    <tr key={feed.feedId} className="border-t border-neutral-300 align-top">
                      <th scope="row" className="p-2 font-medium">{feed.feedName}</th>
                      <td className="p-2">
                        <span className={feed.status === "error" ? "font-semibold text-red-800" : undefined}>
                          {resultLabel(feed)}
                        </span>
                        {feed.error ? <span className="mt-1 block text-red-800">{feed.error}</span> : null}
                      </td>
                      <td className="p-2 text-right tabular-nums">{feed.fetched}</td>
                      <td className="p-2 text-right font-semibold tabular-nums">{feed.imported}</td>
                      <td className="p-2 text-right tabular-nums">{feed.duplicates}</td>
                      <td className="p-2 text-right tabular-nums">{feed.filtered.language}</td>
                      <td className="p-2 text-right tabular-nums">{feed.filtered.requiredLanguage}</td>
                      <td className="p-2 text-right tabular-nums">{feed.filtered.role}</td>
                      <td className="p-2 text-right tabular-nums">{feed.filtered.region}</td>
                      <td className="p-2 text-right tabular-nums">{feed.invalid}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <h3 className="text-base font-semibold">Sources and history</h3>
          {statuses === null ? (
            <p className={hintClass}>Loading…</p>
          ) : (
            <ul role="list" className="divide-y divide-neutral-300 rounded-md border border-neutral-300">
              {statuses.map((feed) => (
                <li key={feed.id} className="space-y-0.5 p-3 text-sm">
                  <p className="font-semibold text-neutral-900">
                    {feed.name}
                    {feed.enabled ? null : <span className="ml-2 font-normal text-neutral-700">(switched off in config)</span>}
                  </p>
                  {feed.lastRun ? (
                    <p className={feed.lastRun.status === "ERROR" ? "text-red-800" : "text-neutral-800"}>
                      Last run {whenText(feed.lastRun.finishedAt)}:{" "}
                      {feed.lastRun.status === "ERROR"
                        ? `failed. ${feed.lastRun.error ?? ""}`
                        : `${feed.lastRun.imported} imported, ${feed.lastRun.filtered} filtered out, ${feed.lastRun.duplicates} already had.`}
                    </p>
                  ) : (
                    <p className="text-neutral-800">Not synced yet.</p>
                  )}
                  {feed.nextAllowedAt ? (
                    <p className="text-neutral-700">Can be synced again after {whenText(feed.nextAllowedAt)}.</p>
                  ) : null}
                  {feed.attribution ? <p className="text-neutral-700">Credit shown on jobs: {feed.attribution}</p> : null}
                </li>
              ))}
            </ul>
          )}
          <p className={hintClass}>
            {autoSync === null
              ? null
              : autoSync.enabled
                ? `Syncs automatically while the app is running (about every ${Math.round(autoSync.intervalMinutes / 60 * 10) / 10} hours). `
                : "Automatic syncing is off; use the button. "}
            Only English-language ads are kept. Ads that ask for Swedish, German or another language are skipped even
            if they are written in English. Edit <code>config/job-feeds.json</code> and <code>config/language-rules.json</code> to
            change sources and rules.
          </p>
        </div>
      </section>
    </div>
  );
}

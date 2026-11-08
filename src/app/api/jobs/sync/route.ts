import { NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-handler";
import { AppError, ValidationError } from "@/lib/errors";
import { getFeedStatuses, isSyncRunning, syncFeeds } from "@/lib/feed-ingestor";
import { getFeedConfig } from "@/lib/feeds/config";
import { parseJsonBody } from "@/lib/validation";
import { syncRequestSchema } from "@/schemas/feed";

export const dynamic = "force-dynamic";

/**
 * Syncing makes outbound requests and writes to the database, so a web page on another site must
 * not be able to trigger it from the user's browser. Browsers always send an Origin header on a
 * cross-site POST; it has to match this server's host. Requests without Origin (curl, scripts)
 * are same-machine tools and are allowed.
 */
function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin === null) return;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost !== host) {
    throw new AppError(403, "FORBIDDEN", "Cross-site requests are not allowed.");
  }
}

/** GET /api/jobs/sync: the configured feeds with their last run, when each may be synced again, and the auto-sync setting. */
export const GET = withApiHandler(async () => {
  const feeds = await getFeedStatuses();
  const { autoSync } = getFeedConfig().settings;
  return NextResponse.json(
    { feeds, running: isSyncRunning(), autoSync: { enabled: autoSync.enabled && process.env["AUTO_SYNC"] !== "off", intervalMinutes: autoSync.intervalMinutes } },
    { headers: { "cache-control": "no-store" } },
  );
});

/**
 * POST /api/jobs/sync   { "feedIds"?: ["jobicy", "teamtailor:tibber"] }
 * Syncs the given feeds (default: every enabled feed) and returns what was imported and filtered
 * out, per feed. Feeds inside their cooldown come back as "rate_limited" with retryAfterSeconds.
 */
export const POST = withApiHandler(async (req) => {
  assertSameOrigin(req);
  const body = await parseJsonBody(req, syncRequestSchema, { maxBytes: 4096 });

  if (body.feedIds !== undefined) {
    const known = new Set(getFeedConfig().feeds.map((feed) => feed.id));
    const unknown = body.feedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ValidationError(
        unknown.map((id) => ({ path: "feedIds", message: `Unknown feed "${id}"`, code: "custom" })),
      );
    }
  }

  const summary = await syncFeeds({ feedIds: body.feedIds });
  return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
});

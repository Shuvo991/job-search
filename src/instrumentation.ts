/**
 * Runs once when the Next.js server starts (next dev / next start). Used to start the background
 * feed sync; see src/lib/auto-sync.ts. Skipped for the Edge runtime, which has no database.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { startAutoSyncFromConfig } = await import("./lib/auto-sync");
  startAutoSyncFromConfig();
}

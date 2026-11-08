/**
 * Decides which jobs already on the board break the location rule (see src/lib/geo-filter.ts), so the
 * clean-up script can show or remove them. Pure logic: the script (prisma/prune-geo.ts) does the I/O.
 *
 * Only jobs that came from a feed are ever candidates (they have an external id), and a job you have
 * applied for or generated documents for is always kept. Jobs you added yourself and the sample jobs
 * are never touched.
 */
import type { GeoFilter, GeoRejectReason } from "@/lib/geo-filter";

export interface StoredJob {
  id: string;
  title: string;
  company: string;
  location: string | null;
  country: string | null;
  workMode: string;
  description: string;
  sourceName: string;
  externalId: string | null;
  applications: number;
  documents: number;
}

export interface GeoViolation {
  id: string;
  title: string;
  company: string;
  sourceName: string;
  location: string;
  workMode: string;
  reason: GeoRejectReason;
}

export interface GeoPruneReport {
  /** Imported jobs that fail the rule and can be removed. */
  remove: GeoViolation[];
  /** Imported jobs that fail the rule but are kept because you have applications or documents on them. */
  keptBecauseInUse: GeoViolation[];
  /** Jobs that were not checked (added by hand, or sample data). */
  skipped: number;
  checked: number;
}

export function planGeoPrune(
  jobs: StoredJob[],
  filter: GeoFilter,
  /** Source names (feed display names) whose empty location means "worldwide". */
  worldwideWhenNoLocation: ReadonlySet<string>,
): GeoPruneReport {
  const report: GeoPruneReport = { remove: [], keptBecauseInUse: [], skipped: 0, checked: 0 };
  for (const job of jobs) {
    if (job.externalId === null) {
      report.skipped += 1;
      continue;
    }
    report.checked += 1;
    // The stored country may be the feed's default, so it is only a fallback (like in the importer).
    const verdict = filter.evaluate({
      workMode: job.workMode,
      location: job.location ?? undefined,
      defaultCountry: job.country ?? undefined,
      description: job.description,
      worldwideWhenNoLocation: worldwideWhenNoLocation.has(job.sourceName),
    });
    if (verdict.accepted) continue;
    const violation: GeoViolation = {
      id: job.id,
      title: job.title,
      company: job.company,
      sourceName: job.sourceName,
      location: job.location ?? job.country ?? "",
      workMode: job.workMode,
      reason: verdict.reason,
    };
    (job.applications > 0 || job.documents > 0 ? report.keptBecauseInUse : report.remove).push(violation);
  }
  return report;
}

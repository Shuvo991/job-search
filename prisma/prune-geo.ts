/**
 * Removes imported jobs that break the location rule (Europe, or remote and open worldwide).
 *
 *   npm run db:prune-geo            shows what would be removed (changes nothing)
 *   npm run db:prune-geo -- --apply removes them
 *
 * Jobs you added yourself, the sample jobs, and any job with an application or generated document
 * are never removed. Removed jobs can come back only if the rule is loosened; the importer applies
 * the same rule to everything new.
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { getFeedConfig } from "@/lib/feeds/config";
import { getGeoFilter } from "@/lib/geo-filter";
import { planGeoPrune, type GeoViolation, type StoredJob } from "@/lib/jobs/geo-prune";

const apply = process.argv.includes("--apply");

function tally(items: GeoViolation[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = `${item.sourceName}: ${item.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `  ${String(count).padStart(4)}  ${key}`);
}

async function main(): Promise<void> {
  const rows = await prisma.job.findMany({
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      country: true,
      workMode: true,
      description: true,
      sourceName: true,
      externalId: true,
      _count: { select: { applications: true, documents: true } },
    },
  });
  const jobs: StoredJob[] = rows.map(({ _count, ...job }) => ({
    ...job,
    applications: _count.applications,
    documents: _count.documents,
  }));

  const flagged = new Set(
    getFeedConfig()
      .feeds.filter((feed) => feed.worldwideWhenNoLocation)
      .map((feed) => feed.name),
  );
  const report = planGeoPrune(jobs, getGeoFilter(), flagged);

  console.log(`Checked ${report.checked} imported jobs (${report.skipped} added by hand or sample data were skipped).`);
  console.log(`${report.remove.length} break the location rule${apply ? "" : " and would be removed"}:`);
  for (const line of tally(report.remove)) console.log(line);
  if (report.keptBecauseInUse.length > 0) {
    console.log(`\n${report.keptBecauseInUse.length} more break the rule but are kept because you have applications or documents on them:`);
    for (const item of report.keptBecauseInUse) console.log(`  ${item.title} at ${item.company} (${item.location || "no location"})`);
  }

  if (!apply) {
    console.log("\nNothing was changed. Run `npm run db:prune-geo -- --apply` to remove them.");
    return;
  }
  const ids = report.remove.map((item) => item.id);
  let removed = 0;
  for (let start = 0; start < ids.length; start += 200) {
    const result = await prisma.job.deleteMany({ where: { id: { in: ids.slice(start, start + 200) } } });
    removed += result.count;
  }
  console.log(`\nRemoved ${removed} jobs.`);
}

main()
  .catch((error: unknown) => {
    console.error("Pruning failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * Seeds five realistic sample jobs. Safe to run repeatedly: a job whose fingerprint
 * (company + title + location) already exists is left untouched.
 *
 *   npm run db:seed
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { buildJobFromRequest } from "@/lib/jobs/build-job";
import { upsertJobByFingerprint } from "@/lib/jobs/repository";
import { SEED_JOBS } from "./seed-data";

const MS_PER_DAY = 86_400_000;

async function main(): Promise<void> {
  const now = Date.now();
  let created = 0;

  for (const { daysAgo, request } of SEED_JOBS) {
    const postedAt = new Date(now - daysAgo * MS_PER_DAY);
    // Same sanitising / skill-extraction pipeline as the Add Job form, then labelled as sample data.
    const job = { ...buildJobFromRequest(request, postedAt), sourceName: "Sample data" };
    const result = await upsertJobByFingerprint(job);
    if (result.created) created += 1;
    console.log(`${result.created ? "added  " : "exists "} ${job.title} at ${job.company}`);
  }

  console.log(`\nDone: ${created} added, ${SEED_JOBS.length - created} already present.`);
}

main()
  .catch((error: unknown) => {
    console.error("Seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

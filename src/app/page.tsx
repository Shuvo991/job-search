import type { Metadata } from "next";
import { ActiveFilters } from "@/components/jobs/active-filters";
import { AddJobDialog } from "@/components/jobs/add-job-dialog";
import { JobCard } from "@/components/jobs/job-card";
import { JobFilters } from "@/components/jobs/job-filters";
import { Pagination } from "@/components/jobs/pagination";
import { SyncFeedsPanel } from "@/components/jobs/sync-feeds-panel";
import { linkClass } from "@/components/ui/styles";
import { getJobFacets, listJobs } from "@/lib/jobs/repository";
import { parseJobsSearchParamsLeniently, type RawSearchParams } from "@/lib/jobs/search-params";
import Link from "next/link";

export const metadata: Metadata = { title: "Browse jobs" };
// Always read the live database: jobs are added while the app is running.
export const dynamic = "force-dynamic";

export default async function JobBoardPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const query = parseJobsSearchParamsLeniently(await searchParams);
  const [result, facets] = await Promise.all([listJobs(query), getJobFacets()]);
  const now = new Date();

  const hasFilters =
    Boolean(query.q || query.roleCategory || query.location || query.workMode || query.seniority) ||
    query.skills.length > 0;
  const firstShown = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const lastShown = Math.min(result.total, result.page * result.pageSize);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tech jobs</h1>
          <p className="mt-1 text-base text-neutral-800">
            {facets.totalActive} open {facets.totalActive === 1 ? "role" : "roles"} for engineers, product, data and
            delivery people.
          </p>
        </div>
        <AddJobDialog />
      </div>

      <SyncFeedsPanel />

      <JobFilters query={query} facets={facets} />
      <ActiveFilters query={query} />

      <section aria-labelledby="results-heading">
        <h2 id="results-heading" className="text-xl font-semibold">
          Results
        </h2>
        <p className="mt-1 text-base text-neutral-800">
          {result.total === 0
            ? "No jobs found."
            : `Showing ${firstShown}–${lastShown} of ${result.total} ${result.total === 1 ? "job" : "jobs"}.`}
        </p>

        {result.items.length > 0 ? (
          <ul role="list" className="mt-4 space-y-4">
            {result.items.map((job) => (
              <li key={job.id}>
                <JobCard job={job} now={now} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 rounded-lg border border-neutral-400 bg-neutral-50 p-6">
            {hasFilters ? (
              <>
                <h3 className="text-lg font-semibold">No jobs match these filters</h3>
                <p className="mt-1 text-neutral-800">
                  Try removing a filter or searching for fewer words.{" "}
                  <Link href="/" className={linkClass}>
                    Clear all filters
                  </Link>
                </p>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold">The board is empty</h3>
                <p className="mt-1 text-neutral-800">
                  Use “Add job” above, or load sample jobs by running <code className="rounded bg-neutral-200 px-1">npm run db:seed</code>{" "}
                  in the project folder.
                </p>
              </>
            )}
          </div>
        )}

        <Pagination query={query} totalPages={result.totalPages} />
      </section>
    </div>
  );
}

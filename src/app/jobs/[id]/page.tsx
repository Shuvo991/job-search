import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/jobs/job-card";
import { chipClass, linkClass, primaryButtonClass } from "@/components/ui/styles";
import { descriptionToBlocks, formatPlace, formatPosted, formatSalary, safeHref } from "@/lib/jobs/format";
import {
  EMPLOYMENT_TYPE_LABELS,
  ROLE_LABELS,
  SECTOR_LABELS,
  SENIORITY_LABELS,
  WORK_MODE_LABELS,
} from "@/lib/jobs/labels";
import { getJobById } from "@/lib/jobs/repository";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const job = await getJobById((await params).id);
  return { title: job ? `${job.title} at ${job.company}` : "Job not found" };
}

export default async function JobPage({ params }: Props) {
  const job = await getJobById((await params).id);
  if (!job) notFound();

  const place = formatPlace(job.location, job.country);
  const salary = formatSalary(job);
  const posted = formatPosted(job.postedAt);
  const applyHref = safeHref(job.applyUrl);
  const sourceHref = safeHref(job.sourceUrl);
  // Descriptions are stored as sanitised plain text and rendered as text nodes only (React escapes them).
  const blocks = descriptionToBlocks(job.description);

  return (
    <article aria-labelledby="job-title" className="space-y-6">
      <p>
        <Link href="/" className={linkClass}>
          <span aria-hidden="true">← </span>Back to all jobs
        </Link>
      </p>

      <header className="space-y-3">
        <h1 id="job-title" className="text-3xl font-bold tracking-tight">
          {job.title}
        </h1>
        <p className="text-lg text-neutral-800">
          <span className="font-semibold">{job.company}</span>
          {place ? <span> · {place}</span> : null}
        </p>
        <ul aria-label="Job details" className="flex flex-wrap gap-2">
          <Badge>{ROLE_LABELS[job.roleCategory]}</Badge>
          {job.workMode !== "UNKNOWN" ? <Badge>{WORK_MODE_LABELS[job.workMode]}</Badge> : null}
          {job.seniority !== "UNKNOWN" ? <Badge>{SENIORITY_LABELS[job.seniority]}</Badge> : null}
          {job.employmentType !== "UNKNOWN" ? <Badge>{EMPLOYMENT_TYPE_LABELS[job.employmentType]}</Badge> : null}
          <Badge>{SECTOR_LABELS[job.sector]}</Badge>
        </ul>
        {salary ? <p className="text-base font-medium">{salary}</p> : null}
        <p className="text-sm text-neutral-700">
          {posted && job.postedAt ? <time dateTime={job.postedAt.toISOString()}>{posted}</time> : null}
          {posted ? " · " : null}
          Source: {sourceHref ? (
            <a href={sourceHref} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>
              {job.sourceName}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            job.sourceName
          )}
          {job.attribution ? <span> · {job.attribution}</span> : null}
        </p>
        {applyHref ? (
          <p>
            <a href={applyHref} target="_blank" rel="noopener noreferrer nofollow" className={primaryButtonClass}>
              Apply on the company site
              <span className="sr-only"> (opens in a new tab)</span>
              <span aria-hidden="true">↗</span>
            </a>
          </p>
        ) : null}
      </header>

      {job.skills.length > 0 ? (
        <section aria-labelledby="skills-heading">
          <h2 id="skills-heading" className="text-xl font-semibold">
            Skills
          </h2>
          <ul role="list" className="mt-2 flex flex-wrap gap-2">
            {job.skills.map((skill) => (
              <li key={skill} className={chipClass}>
                {skill}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="description-heading" className="max-w-3xl">
        <h2 id="description-heading" className="text-xl font-semibold">
          Description
        </h2>
        <div className="mt-2 space-y-4 text-base leading-relaxed text-neutral-900">
          {blocks.map((block, index) => {
            if (block.type === "heading") {
              return (
                <h3 key={index} className="pt-2 text-lg font-semibold">
                  {block.text}
                </h3>
              );
            }
            if (block.type === "list") {
              return (
                <ul key={index} className="list-disc space-y-1 pl-6">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{item}</li>
                  ))}
                </ul>
              );
            }
            return <p key={index}>{block.text}</p>;
          })}
        </div>
      </section>
    </article>
  );
}

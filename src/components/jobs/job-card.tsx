import Link from "next/link";
import { formatPlace, formatPosted, formatSalary } from "@/lib/jobs/format";
import {
  EMPLOYMENT_TYPE_LABELS,
  ROLE_LABELS,
  SECTOR_LABELS,
  SENIORITY_LABELS,
  WORK_MODE_LABELS,
} from "@/lib/jobs/labels";
import type { JobListItem } from "@/lib/jobs/repository";
import { chipClass, linkClass } from "@/components/ui/styles";

const MAX_SKILLS_ON_CARD = 8;

export function Badge({ children }: { children: React.ReactNode }) {
  return (
    <li className="rounded-md border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-sm font-medium text-indigo-950">
      {children}
    </li>
  );
}

export function JobCard({ job, now }: { job: JobListItem; now: Date }) {
  const titleId = `job-${job.id}-title`;
  const place = formatPlace(job.location, job.country);
  const salary = formatSalary(job);
  const posted = formatPosted(job.postedAt, now);
  const shownSkills = job.skills.slice(0, MAX_SKILLS_ON_CARD);
  const hiddenSkills = job.skills.length - shownSkills.length;

  return (
    <article
      aria-labelledby={titleId}
      className="rounded-lg border border-neutral-400 bg-white p-4 shadow-sm sm:p-5"
    >
      <h3 id={titleId} className="text-lg font-semibold leading-snug">
        <Link href={`/jobs/${job.id}`} className={linkClass}>
          {job.title}
        </Link>
      </h3>
      <p className="mt-1 text-base text-neutral-800">
        <span className="font-medium">{job.company}</span>
        {place ? <span> · {place}</span> : null}
      </p>

      <ul aria-label="Job details" className="mt-3 flex flex-wrap gap-2">
        <Badge>{ROLE_LABELS[job.roleCategory]}</Badge>
        {job.workMode !== "UNKNOWN" ? <Badge>{WORK_MODE_LABELS[job.workMode]}</Badge> : null}
        {job.seniority !== "UNKNOWN" ? <Badge>{SENIORITY_LABELS[job.seniority]}</Badge> : null}
        {job.employmentType !== "UNKNOWN" ? <Badge>{EMPLOYMENT_TYPE_LABELS[job.employmentType]}</Badge> : null}
        <Badge>{SECTOR_LABELS[job.sector]}</Badge>
      </ul>

      {salary ? <p className="mt-3 text-base font-medium text-neutral-900">{salary}</p> : null}
      {job.excerpt ? <p className="mt-3 text-base text-neutral-800">{job.excerpt}</p> : null}

      {shownSkills.length > 0 ? (
        <ul aria-label="Skills" className="mt-3 flex flex-wrap gap-2">
          {shownSkills.map((skill) => (
            <li key={skill} className={chipClass}>
              {skill}
            </li>
          ))}
          {hiddenSkills > 0 ? (
            <li className="inline-flex items-center px-1 text-sm text-neutral-700">
              +{hiddenSkills} more
              <span className="sr-only"> skills, shown on the job page</span>
            </li>
          ) : null}
        </ul>
      ) : null}

      <p className="mt-3 text-sm text-neutral-700">
        {posted && job.postedAt ? <time dateTime={job.postedAt.toISOString()}>{posted}</time> : null}
        {posted ? " · " : null}
        Source: {job.sourceName}
      </p>
    </article>
  );
}

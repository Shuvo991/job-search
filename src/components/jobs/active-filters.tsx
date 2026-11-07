import Link from "next/link";
import { ROLE_LABELS, SENIORITY_LABELS, WORK_MODE_LABELS } from "@/lib/jobs/labels";
import { buildQueryString } from "@/lib/jobs/search-params";
import type { ListJobsQuery } from "@/schemas/job";

interface Chip {
  key: string;
  label: string;
  href: string;
}

function chipsFor(query: ListJobsQuery): Chip[] {
  const without = (overrides: Partial<ListJobsQuery>) => `/${buildQueryString(query, { ...overrides, page: 1 })}`;
  const chips: Chip[] = [];
  if (query.q) chips.push({ key: "q", label: `Search: ${query.q}`, href: without({ q: undefined }) });
  if (query.roleCategory) {
    chips.push({ key: "role", label: `Role: ${ROLE_LABELS[query.roleCategory]}`, href: without({ roleCategory: undefined }) });
  }
  if (query.location) chips.push({ key: "loc", label: `Location: ${query.location}`, href: without({ location: undefined }) });
  if (query.workMode) {
    chips.push({ key: "mode", label: `Work mode: ${WORK_MODE_LABELS[query.workMode]}`, href: without({ workMode: undefined }) });
  }
  if (query.seniority) {
    chips.push({ key: "level", label: `Level: ${SENIORITY_LABELS[query.seniority]}`, href: without({ seniority: undefined }) });
  }
  for (const skill of query.skills) {
    chips.push({
      key: `skill-${skill}`,
      label: `Skill: ${skill}`,
      href: without({ skills: query.skills.filter((item) => item !== skill) }),
    });
  }
  return chips;
}

/** The filters currently applied, each removable with one link. */
export function ActiveFilters({ query }: { query: ListJobsQuery }) {
  const chips = chipsFor(query);
  if (chips.length === 0) return null;

  return (
    <ul aria-label="Active filters" className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <li key={chip.key}>
          <Link
            href={chip.href}
            aria-label={`Remove filter ${chip.label}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-indigo-400 bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-950 hover:bg-indigo-100"
          >
            <span>{chip.label}</span>
            <span aria-hidden="true" className="text-base leading-none">
              ×
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

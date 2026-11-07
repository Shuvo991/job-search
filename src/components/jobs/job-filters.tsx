import Link from "next/link";
import { controlClass, hintClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { ROLE_LABELS, SENIORITY_LABELS, WORK_MODE_LABELS } from "@/lib/jobs/labels";
import type { JobFacets } from "@/lib/jobs/repository";
import { ROLE_CATEGORIES, SENIORITIES, WORK_MODES } from "@/schemas/enums";
import type { ListJobsQuery } from "@/schemas/job";

const VISIBLE_SKILLS = 8;

/**
 * Filter panel. It is a plain GET form: it works without JavaScript, the URL is shareable, and
 * nothing changes until the user presses "Apply filters" (WCAG 3.2.2: no change of context on input).
 */
export function JobFilters({ query, facets }: { query: ListJobsQuery; facets: JobFacets }) {
  // Show every selected skill even when it is no longer among the most common ones.
  const known = new Set(facets.skills.map((skill) => skill.name.toLowerCase()));
  const extras = query.skills.filter((skill) => !known.has(skill.toLowerCase()));
  const skills = [...facets.skills, ...extras.map((name) => ({ name, count: 0 }))];
  const selected = new Set(query.skills.map((skill) => skill.toLowerCase()));
  const primary = skills.slice(0, VISIBLE_SKILLS);
  const overflow = skills.slice(VISIBLE_SKILLS);
  const overflowHasSelection = overflow.some((skill) => selected.has(skill.name.toLowerCase()));

  const renderSkill = (skill: { name: string; count: number }) => {
    const id = `filter-skill-${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return (
      <li key={skill.name}>
        <label htmlFor={id} className="flex min-h-11 items-center gap-2 text-base text-neutral-900">
          <input
            id={id}
            type="checkbox"
            name="skill"
            value={skill.name}
            defaultChecked={selected.has(skill.name.toLowerCase())}
            className="size-5 shrink-0 accent-indigo-700"
          />
          <span>
            {skill.name}
            {skill.count > 0 ? <span className="text-neutral-700"> ({skill.count})</span> : null}
          </span>
        </label>
      </li>
    );
  };

  return (
    <form
      action="/"
      method="get"
      role="search"
      aria-label="Filter jobs"
      className="space-y-5 rounded-lg border border-neutral-400 bg-neutral-50 p-4 sm:p-5"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-2">
          <label htmlFor="filter-q" className={labelClass}>
            Search
          </label>
          <input
            id="filter-q"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            autoComplete="off"
            aria-describedby="filter-q-hint"
            placeholder="Title, company or keyword"
            className={`${controlClass} mt-1`}
          />
          <p id="filter-q-hint" className={hintClass}>
            Every word you type must appear in the job.
          </p>
        </div>

        <div>
          <label htmlFor="filter-role" className={labelClass}>
            Role type
          </label>
          <select
            id="filter-role"
            name="roleCategory"
            defaultValue={query.roleCategory ?? ""}
            className={`${controlClass} mt-1`}
          >
            <option value="">All role types</option>
            {ROLE_CATEGORIES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-location" className={labelClass}>
            Location
          </label>
          <input
            id="filter-location"
            name="location"
            type="text"
            list="filter-location-options"
            defaultValue={query.location ?? ""}
            autoComplete="off"
            placeholder="City or country"
            className={`${controlClass} mt-1`}
          />
          <datalist id="filter-location-options">
            {facets.locations.map((location) => (
              <option key={location} value={location} />
            ))}
          </datalist>
        </div>

        <div>
          <label htmlFor="filter-workmode" className={labelClass}>
            Work mode
          </label>
          <select
            id="filter-workmode"
            name="workMode"
            defaultValue={query.workMode ?? ""}
            className={`${controlClass} mt-1`}
          >
            <option value="">Any work mode</option>
            {WORK_MODES.filter((mode) => mode !== "UNKNOWN").map((mode) => (
              <option key={mode} value={mode}>
                {WORK_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-seniority" className={labelClass}>
            Level
          </label>
          <select
            id="filter-seniority"
            name="seniority"
            defaultValue={query.seniority ?? ""}
            className={`${controlClass} mt-1`}
          >
            <option value="">Any level</option>
            {SENIORITIES.filter((level) => level !== "UNKNOWN").map((level) => (
              <option key={level} value={level}>
                {SENIORITY_LABELS[level]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {skills.length > 0 ? (
        <fieldset>
          <legend className={labelClass}>Skills</legend>
          <p className={hintClass}>Jobs must include every skill you tick.</p>
          <ul role="list" className="mt-1 grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
            {primary.map(renderSkill)}
          </ul>
          {overflow.length > 0 ? (
            <details open={overflowHasSelection} className="mt-1">
              <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-indigo-800 underline underline-offset-2">
                More skills ({overflow.length})
              </summary>
              <ul role="list" className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
                {overflow.map(renderSkill)}
              </ul>
            </details>
          ) : null}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button type="submit" className={primaryButtonClass}>
          Apply filters
        </button>
        <Link href="/" className={secondaryButtonClass}>
          Clear all filters
        </Link>
      </div>
    </form>
  );
}

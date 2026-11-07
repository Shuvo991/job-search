import Link from "next/link";
import { buildQueryString } from "@/lib/jobs/search-params";
import type { ListJobsQuery } from "@/schemas/job";

const base =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-3 text-base font-medium";
const linkStyle = `${base} border-neutral-500 bg-white text-neutral-900 hover:bg-neutral-100`;
const currentStyle = `${base} border-indigo-800 bg-indigo-800 text-white`;
const disabledStyle = `${base} border-neutral-300 bg-neutral-100 text-neutral-600`;

function pageWindow(current: number, total: number): number[] {
  const pages = new Set<number>([1, total]);
  for (let page = current - 2; page <= current + 2; page += 1) {
    if (page >= 1 && page <= total) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function Pagination({ query, totalPages }: { query: ListJobsQuery; totalPages: number }) {
  if (totalPages <= 1) return null;
  const hrefFor = (page: number) => `/${buildQueryString(query, { page })}`;
  const pages = pageWindow(query.page, totalPages);

  return (
    <nav aria-label="Pagination" className="mt-6">
      <ul className="flex flex-wrap items-center gap-2">
        <li>
          {query.page > 1 ? (
            <Link href={hrefFor(query.page - 1)} rel="prev" className={linkStyle}>
              Previous<span className="sr-only"> page</span>
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledStyle}>
              Previous<span className="sr-only"> page (not available)</span>
            </span>
          )}
        </li>
        {pages.map((page, index) => {
          const previous = pages[index - 1];
          return (
            <li key={page} className="flex items-center gap-2">
              {previous !== undefined && page - previous > 1 ? (
                <span aria-hidden="true" className="px-1 text-neutral-700">
                  …
                </span>
              ) : null}
              {page === query.page ? (
                <span aria-current="page" className={currentStyle}>
                  <span className="sr-only">Page </span>
                  {page}
                </span>
              ) : (
                <Link href={hrefFor(page)} className={linkStyle}>
                  <span className="sr-only">Page </span>
                  {page}
                </Link>
              )}
            </li>
          );
        })}
        <li>
          {query.page < totalPages ? (
            <Link href={hrefFor(query.page + 1)} rel="next" className={linkStyle}>
              Next<span className="sr-only"> page</span>
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledStyle}>
              Next<span className="sr-only"> page (not available)</span>
            </span>
          )}
        </li>
      </ul>
    </nav>
  );
}

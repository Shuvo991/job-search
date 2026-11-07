import { ZodError } from "zod";
import { parseWith } from "@/lib/validation";
import { listJobsQuerySchema, type ListJobsQuery } from "@/schemas/job";

export type RawSearchParams = Record<string, string | string[] | undefined>;

export const BOARD_PAGE_SIZE = 10;

/** Normalise Next.js `searchParams` (an object) or a URLSearchParams into URLSearchParams. */
export function toURLSearchParams(source: URLSearchParams | RawSearchParams): URLSearchParams {
  if (source instanceof URLSearchParams) return new URLSearchParams(source);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.append(key, value);
  }
  return params;
}

/**
 * Convert URL parameters into the raw shape listJobsQuerySchema expects.
 * Empty values (an untouched filter in an HTML form) are ignored; `skill` may repeat
 * (?skill=React&skill=SQL) or be comma separated (?skill=React,SQL).
 */
function toRawQuery(params: URLSearchParams, defaultPageSize: number): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of ["q", "roleCategory", "sector", "workMode", "seniority", "location", "isActive", "page", "pageSize"]) {
    const value = params.get(key)?.trim();
    if (value) raw[key] = value;
  }
  const skills = params
    .getAll("skill")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (skills.length > 0) raw["skills"] = skills;
  raw["pageSize"] ??= String(defaultPageSize);
  return raw;
}

/** Strict parsing for the API: throws ValidationError (HTTP 400) on bad input. */
export function parseJobsSearchParams(
  source: URLSearchParams | RawSearchParams,
  options: { defaultPageSize?: number } = {},
): ListJobsQuery {
  const raw = toRawQuery(toURLSearchParams(source), options.defaultPageSize ?? 25);
  return parseWith(listJobsQuerySchema, raw);
}

/**
 * Lenient parsing for the page: a hand-edited URL such as ?roleCategory=NOPE should not crash
 * the board, so offending parameters are dropped and the rest still apply.
 */
export function parseJobsSearchParamsLeniently(
  source: URLSearchParams | RawSearchParams,
  options: { defaultPageSize?: number } = {},
): ListJobsQuery {
  const raw = toRawQuery(toURLSearchParams(source), options.defaultPageSize ?? BOARD_PAGE_SIZE);
  const result = listJobsQuerySchema.safeParse(raw);
  if (result.success) return result.data;

  const cleaned = { ...raw };
  for (const issue of (result.error as ZodError).issues) {
    const key = issue.path[0];
    if (typeof key === "string" && key !== "pageSize") delete cleaned[key];
    else if (key === "pageSize") cleaned["pageSize"] = String(options.defaultPageSize ?? BOARD_PAGE_SIZE);
  }
  return listJobsQuerySchema.parse(cleaned);
}

/** Build a query string for links (pagination, "remove filter" chips) from the active filters. */
export function buildQueryString(query: Partial<ListJobsQuery>, overrides: Partial<ListJobsQuery> = {}): string {
  const merged = { ...query, ...overrides };
  const params = new URLSearchParams();
  const simple = ["q", "roleCategory", "sector", "workMode", "seniority", "location"] as const;
  for (const key of simple) {
    const value = merged[key];
    if (value) params.set(key, value);
  }
  for (const skill of merged.skills ?? []) params.append("skill", skill);
  if (merged.page && merged.page > 1) params.set("page", String(merged.page));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

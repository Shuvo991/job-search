/**
 * Turns one raw feed item into a validated, sanitised job ready to store.
 *
 * Two phases so that cheap checks run first and the expensive work (language detection, skill
 * extraction) is only spent on items that can still be imported:
 *   prepareItem  -> sanitise every field, canonicalise the link, reject unusable items
 *   buildFeedJob -> infer role / level / work mode, extract skills, validate with createJobSchema
 */
import { createHash } from "node:crypto";
import type { ResolvedFeed } from "@/lib/feeds/config";
import type { RawFeedItem } from "@/lib/feeds/adapters";
import { sanitizeFeedHtml, sanitizeFeedInline } from "@/lib/feeds/sanitize-feed";
import {
  extractRequirements,
  inferEmploymentType,
  inferRoleCategory,
  inferSector,
  inferSeniority,
  inferWorkMode,
  type EmploymentTypeValue,
  type RoleCategoryValue,
  type WorkModeValue,
} from "@/lib/job-inference";
import { uniqueSkills } from "@/lib/jobs/analyze";
import { normalizeHttpUrl } from "@/lib/sanitize";
import { extractSkillNames } from "@/lib/skills-extractor";
import { parseWith } from "@/lib/validation";
import { createJobSchema, type CreateJobInput } from "@/schemas/job";

export const MAX_DESCRIPTION_CHARS = 100_000;

export interface PreparedItem {
  title: string;
  company: string;
  /** Sanitised plain text. */
  description: string;
  location: string | undefined;
  country: string | undefined;
  /** Canonical link to the posting (stored as `sourceUrl`, used for de-duplication). */
  externalUrl: string;
  applyUrl: string | undefined;
  externalId: string | undefined;
  postedAt: Date | undefined;
  raw: RawFeedItem;
}

export type PrepareResult = { ok: true; item: PreparedItem } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|mc_[a-z]+|gclid|fbclid|msclkid|ref|referrer|source|src|campaign)$/i;

/**
 * http(s) URL without credentials or fragment, tracking parameters removed and the rest sorted, so
 * two links to the same posting compare equal. Returns undefined for anything else.
 */
export function canonicalizeUrl(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const normalized = normalizeHttpUrl(input);
  if (normalized === undefined) return undefined;
  const url = new URL(normalized);
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

// ---------------------------------------------------------------------------
// Phase 1
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return (lastBreak > max * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

function optionalInline(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeFeedInline(value);
  return clean === "" ? undefined : clip(clean, max);
}

export function prepareItem(raw: RawFeedItem, now: Date): PrepareResult {
  const title = clip(sanitizeFeedInline(raw.title), 200);
  if (title === "") return { ok: false, reason: "missing title" };

  const company = raw.company === undefined ? "" : clip(sanitizeFeedInline(raw.company), 200);
  if (company === "") return { ok: false, reason: "missing company" };

  const applyUrl = canonicalizeUrl(raw.applyUrl);
  const externalUrl = canonicalizeUrl(raw.url) ?? applyUrl;
  if (externalUrl === undefined) return { ok: false, reason: "missing or unusable link" };

  const description = clip(sanitizeFeedHtml(raw.description), MAX_DESCRIPTION_CHARS);
  if (description === "") return { ok: false, reason: "empty description" };

  let externalId: string | undefined;
  if (raw.externalId !== undefined) {
    const id = sanitizeFeedInline(raw.externalId);
    if (id !== "") externalId = id.length <= 200 ? id : createHash("sha256").update(id).digest("hex");
  }

  // Never trust a date from the future (it would pin the job to the top of the board).
  const postedAt = raw.postedAt !== undefined && raw.postedAt.getTime() > now.getTime() ? now : raw.postedAt;

  return {
    ok: true,
    item: {
      title,
      company,
      description,
      location: optionalInline(raw.location, 200),
      country: optionalInline(raw.country, 100),
      externalUrl,
      applyUrl,
      externalId,
      postedAt,
      raw,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2
// ---------------------------------------------------------------------------

function workModeFromHint(hint: string | undefined): WorkModeValue | undefined {
  if (hint === undefined) return undefined;
  const text = hint.toLowerCase();
  if (/hybrid/.test(text)) return "HYBRID";
  if (/^(fully|full|remote|true|yes|anywhere|work from home|wfh)\b|fully remote|100%/.test(text)) return "REMOTE";
  if (/^(none|onsite|on-site|on site|office|in[- ]office)\b/.test(text)) return "ONSITE";
  return undefined;
}

function employmentFromHint(hint: string | undefined): EmploymentTypeValue | undefined {
  if (hint === undefined) return undefined;
  const text = hint.toLowerCase();
  if (/intern/.test(text)) return "INTERNSHIP";
  if (/freelanc/.test(text)) return "FREELANCE";
  if (/contract|temporary|temp\b|consult/.test(text)) return "CONTRACT";
  if (/part[-_ ]?time/.test(text)) return "PART_TIME";
  if (/full[-_ ]?time|permanent|heltid/.test(text)) return "FULL_TIME";
  return undefined;
}

function salaryFrom(raw: RawFeedItem): { salaryMin?: number; salaryMax?: number; salaryCurrency?: string } {
  const currency = raw.salaryCurrency?.trim().toUpperCase();
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) return {};

  const period = raw.salaryPeriod?.toLowerCase();
  let factor = 1;
  if (period !== undefined && !/year|annual|yr/.test(period)) {
    if (/month/.test(period)) factor = 12;
    else return {}; // hourly / daily / weekly figures would be misleading as yearly pay
  }

  const scale = (value: number | undefined) =>
    value === undefined || value <= 0 || value * factor > 1e9 ? undefined : Math.round(value * factor);
  const min = scale(raw.salaryMin);
  const max = scale(raw.salaryMax);
  if (min !== undefined && max !== undefined && min > max) return {};

  const result: { salaryMin?: number; salaryMax?: number; salaryCurrency?: string } = {};
  if (min !== undefined) result.salaryMin = min;
  if (max !== undefined) result.salaryMax = max;
  if (min !== undefined || max !== undefined) result.salaryCurrency = currency;
  return result;
}

/** The role this posting belongs to, judged from its title alone (undefined = not a role we list). */
export function roleOf(item: PreparedItem): RoleCategoryValue | undefined {
  return inferRoleCategory(item.title);
}

export function buildFeedJob(
  item: PreparedItem,
  role: RoleCategoryValue,
  feed: ResolvedFeed,
): CreateJobInput {
  const { title, company, description, location, raw } = item;

  const workMode =
    workModeFromHint(raw.workModeText) ??
    feed.defaults.workMode ??
    inferWorkMode(title, location, description);
  const employmentInferred = employmentFromHint(raw.employmentTypeText) ?? inferEmploymentType(title, description);
  const employmentType =
    employmentInferred === "UNKNOWN" ? (feed.defaults.employmentType ?? "UNKNOWN") : employmentInferred;

  const candidate: Record<string, unknown> = {
    title,
    company,
    roleCategory: role,
    sector: inferSector(title, company, description),
    workMode,
    seniority: inferSeniority(title),
    employmentType,
    description,
    skills: uniqueSkills(extractSkillNames(`${title}\n${description}`)),
    requirements: extractRequirements(description),
    sourceName: feed.name,
    sourceUrl: item.externalUrl,
    ...salaryFrom(raw),
  };
  const optional: Record<string, unknown> = {
    location,
    country: item.country ?? feed.defaults.country,
    applyUrl: item.applyUrl ?? item.externalUrl,
    attribution: feed.attribution,
    externalId: item.externalId,
    postedAt: item.postedAt,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) candidate[key] = value;
  }

  return parseWith(createJobSchema, candidate);
}

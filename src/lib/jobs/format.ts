import { normalizeHttpUrl } from "@/lib/sanitize";

interface SalaryFields {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
}

const MS_PER_DAY = 86_400_000;

/** "SEK 780,000 – 1,020,000 / year"; null when no salary is known. */
export function formatSalary({ salaryMin, salaryMax, salaryCurrency }: SalaryFields): string | null {
  if (salaryMin === null && salaryMax === null) return null;
  const number = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
  const prefix = salaryCurrency ? `${salaryCurrency} ` : "";
  if (salaryMin !== null && salaryMax !== null) {
    return salaryMin === salaryMax
      ? `${prefix}${number.format(salaryMin)} / year`
      : `${prefix}${number.format(salaryMin)} – ${number.format(salaryMax)} / year`;
  }
  return salaryMin !== null ? `From ${prefix}${number.format(salaryMin)} / year` : `Up to ${prefix}${number.format(salaryMax ?? 0)} / year`;
}

/** "Posted today", "Posted 3 days ago", or "Posted 12 Oct 2026" for older jobs. */
export function formatPosted(date: Date | null, now: Date = new Date()): string | null {
  if (!date) return null;
  const days = Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY);
  if (days <= 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  if (days < 30) return `Posted ${days} days ago`;
  return `Posted ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date)}`;
}

/** "Stockholm, Sweden" without repeating the country when the location already contains it. */
export function formatPlace(location: string | null, country: string | null): string | null {
  if (location && country && !location.toLowerCase().includes(country.toLowerCase())) return `${location}, ${country}`;
  return location ?? country;
}

/** Render-time guard: only http(s) links without credentials may become an href. */
export function safeHref(url: string | null): string | undefined {
  return url ? normalizeHttpUrl(url) : undefined;
}

export type DescriptionBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

/**
 * Split a sanitised plain-text description into headings, paragraphs and bullet lists so it can be
 * rendered as real semantic HTML. Every value is a plain string for React to escape; nothing here
 * produces markup.
 */
export function descriptionToBlocks(description: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let list: string[] | undefined;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.length > 0) blocks.push({ type: "list", items: list });
    list = undefined;
  };

  for (const rawLine of description.split("\n")) {
    const line = rawLine.trim();
    const bullet = /^(?:[-*•–·]|\d{1,2}[.)])\s+(\S.*)$/.exec(line);
    if (line === "") {
      flushParagraph();
      flushList();
    } else if (bullet?.[1]) {
      flushParagraph();
      list ??= [];
      list.push(bullet[1]);
    } else if (line.length <= 80 && line.endsWith(":")) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: line.slice(0, -1) });
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

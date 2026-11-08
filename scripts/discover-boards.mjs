#!/usr/bin/env node
/**
 * Finds which public job board each company in config/companies.json uses, by asking the public
 * job-board APIs of Greenhouse, Lever (US and EU), Ashby and Teamtailor whether a board with the
 * company's name exists. A board only counts when it can be tied to the company (the board's own
 * name matches, or the company's name appears in its job ads); anything doubtful is listed under
 * "needs review" instead of being crawled.
 *
 * Results go to config/company-boards.json (read by the sync) and a readable list to
 * data/company-boards-report.md.
 *
 *   npm run discover:boards                       check companies not checked in the last 30 days
 *   npm run discover:boards -- --force            check every company again
 *   npm run discover:boards -- --only "Klarna,King"
 *   npm run discover:boards -- --limit 20         only the first 20 unchecked companies (to try it out)
 *
 * Safe to stop with Ctrl+C and run again: it continues where it stopped. Needs Node 18+ (global fetch).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANIES_FILE = path.join(ROOT, "config", "companies.json");
const BOARDS_FILE = path.join(ROOT, "config", "company-boards.json");
const REPORT_FILE = path.join(ROOT, "data", "company-boards-report.md");

const USER_AGENT = "job-search-local/1.0 (+https://github.com/Shuvo991/job-search)";
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const RECHECK_DAYS = 30;
const MAX_BODY_CHARS = 30_000_000;

/** Titles that match the roles you are looking for (only used for the counts in the report). */
const TARGET_TITLE =
  /\b(?:product (?:manager|owner|analyst|lead)|project manager|program(?:me)? manager|software (?:developer|engineer)|web developer|(?:front[- ]?end|back[- ]?end|full[- ]?stack) (?:developer|engineer)|ai engineer|(?:machine learning|ml) engineer|data analyst|business analyst)\b/i;

/** Company names that are also everyday words: a board with that name is only trusted on an exact board-name match. */
const GENERIC_NAMES = new Set([
  "remote", "wise", "unity", "king", "bolt", "karma", "oda", "mews", "miro", "oyster", "funnel", "candela",
  "tier", "flix", "boku", "tines", "sana", "cint", "hopin", "gelato", "bird", "elastic", "canonical", "mozilla",
  "oura", "plejd", "kivra", "kry", "evolution", "sitecore",
]);

/** Words dropped from the end of a name to get the short brand ("Mojang Studios" -> "Mojang"). */
const NOISE_WORDS = new Set([
  "group", "ab", "inc", "gmbh", "ltd", "llc", "plc", "as", "oy", "bv", "nv", "sa", "technologies", "technology",
  "tech", "software", "labs", "studios", "games", "bank", "consulting", "digital", "holding", "com",
]);

// ---------------------------------------------------------------------------
// Names and slugs
// ---------------------------------------------------------------------------

export function fold(text) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Letters and digits only, accents removed: "H&M Group" -> "hmgroup". */
export function squash(text) {
  return fold(text).replace(/[^a-z0-9]/g, "");
}

/** The names a company goes by: full name (without brackets), short brand, parts of "A / B", and aliases. */
export function nameVariants(company) {
  const main = company.name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const parts = main.split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
  const names = new Set();
  const add = (name) => {
    const trimmed = name.trim();
    if (trimmed.length >= 2) names.add(trimmed);
  };
  for (const part of parts) {
    add(part);
    const words = part.split(" ");
    while (words.length > 1 && NOISE_WORDS.has(fold(words[words.length - 1]).replace(/[^a-z0-9]/g, ""))) words.pop();
    // The short brand is only used when it is still distinctive ("Gen Digital" -> "Gen" is not).
    const brand = words.join(" ").replace(/\.com$/i, "");
    if (brand !== part && squash(brand).length >= 4) add(brand);
  }
  for (const alias of company.aliases ?? []) add(alias);
  return [...names];
}

/** Board names worth trying, most likely first. */
export function slugCandidates(company) {
  const slugs = new Set((company.slugs ?? []).map((slug) => slug.toLowerCase()));
  for (const name of nameVariants(company)) {
    const folded = fold(name).replace(/[^a-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim();
    if (folded === "") continue;
    slugs.add(folded.replace(/[ -]/g, ""));
    if (folded.includes(" ")) slugs.add(folded.replace(/ /g, "-"));
    const first = folded.split(" ")[0];
    if (folded.includes(" ") && first.length >= 5) slugs.add(first);
  }
  return [...slugs].filter((slug) => /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGeneric(variants) {
  return variants.some((name) => GENERIC_NAMES.has(squash(name)));
}

/**
 * Does this board belong to the company? Returns "board-name", "posting-text" or null.
 * `found` is { boardName?, heading?, jobs: [{ title, text }] }.
 */
export function verifyBoard(variants, found) {
  const generic = isGeneric(variants);
  const keys = variants.map(squash).filter((key) => key.length >= 2);

  if (found.boardName !== undefined) {
    const board = squash(found.boardName);
    for (const key of keys) {
      if (board === key) return "board-name";
      if (!generic && key.length >= 4 && board.length >= 4 && (board.startsWith(key) || key.startsWith(board))) {
        return "board-name";
      }
    }
    return null;
  }
  if (generic) return null;

  if (found.heading !== undefined) {
    const heading = squash(found.heading);
    if (keys.some((key) => key.length >= 4 && heading.includes(key))) return "board-name";
  }

  const patterns = variants
    .map(fold)
    .filter((name) => name.length >= 3)
    .map((name) => new RegExp(`(?<![a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`));
  if (patterns.length === 0) return null;
  let hits = 0;
  for (const job of found.jobs) {
    const text = fold(`${job.title} ${job.text}`);
    if (patterns.some((pattern) => pattern.test(text))) hits += 1;
  }
  return hits >= (found.jobs.length === 1 ? 1 : 2) ? "posting-text" : null;
}

// ---------------------------------------------------------------------------
// Talking to the job-board APIs
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** When set (by --probe), every request is noted here so a failed detection can be explained. */
let trace = null;

async function get(url, accept, init = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, accept, ...(init.headers ?? {}) },
        signal: controller.signal,
        redirect: "follow",
      });
      trace?.push(`${response.status} ${init.method ?? "GET"} ${url}${response.url === url ? "" : ` -> ${response.url}`}`);
      if (trace !== null && !response.ok) {
        const note = (await response.clone().text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
        if (note !== "") trace.push(`   body: ${note}`);
      }
      if (response.status === 429 && attempt === 0) {
        const wait = Math.min(30, Number(response.headers.get("retry-after")) || 5);
        await sleep(wait * 1000);
        continue;
      }
      if (!response.ok) return null;
      const text = await response.text();
      return { text: text.slice(0, MAX_BODY_CHARS), url: response.url };
    } catch (error) {
      trace?.push(`failed ${init.method ?? "GET"} ${url}: ${error?.cause?.code ?? error?.name ?? "error"}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function getJson(url) {
  const result = await get(url, "application/json");
  if (result === null) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

const plain = (html) => String(html ?? "").replace(/<[^>]*>/g, " ").slice(0, 3000);

async function probeGreenhouse(slug) {
  const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
  if (meta === null || typeof meta.name !== "string") return null;
  const list = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  const jobs = Array.isArray(list?.jobs) ? list.jobs.map((job) => ({ title: String(job.title ?? ""), text: "" })) : [];
  return { boardName: meta.name, jobs };
}

async function probeLever(slug, host) {
  const list = await getJson(`https://${host}/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(list) || list.length === 0) return null;
  return { jobs: list.map((job) => ({ title: String(job.text ?? ""), text: plain(job.descriptionPlain ?? job.description) })) };
}

async function probeAshby(slug) {
  const body = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (!Array.isArray(body?.jobs) || body.jobs.length === 0) return null;
  return { jobs: body.jobs.map((job) => ({ title: String(job.title ?? ""), text: plain(job.descriptionPlain ?? job.descriptionHtml) })) };
}

async function probeTeamtailor(slug) {
  const result = await get(`https://${slug}.teamtailor.com/jobs.rss`, "application/rss+xml, application/xml;q=0.9");
  if (result === null || !/^[a-z0-9-]+\.teamtailor\.com$/i.test(new URL(result.url).hostname)) return null;
  if (!/<rss[\s>]/i.test(result.text.slice(0, 2000))) return null;
  const clean = (value) => value.replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
  const heading = /<title>([\s\S]*?)<\/title>/i.exec(result.text)?.[1];
  const items = [...result.text.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const title = /<title>([\s\S]*?)<\/title>/i.exec(match[1])?.[1] ?? "";
    return { title: clean(title), text: plain(match[1]) };
  });
  if (items.length === 0) return null;
  return { heading: heading === undefined ? undefined : clean(heading), jobs: items };
}

// --- Other systems (detection only: the site cannot crawl these yet) -------------------------------

/** How often each system answered with something we could not read: a hint that its format changed. */
const stats = {};
const tally = (system, kind) => {
  stats[system] ??= { found: 0, unparseable: 0 };
  stats[system][kind] += 1;
};

async function postJson(url, payload) {
  const result = await get(url, "application/json", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
  if (result === null) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

const cleanXml = (value) => String(value ?? "").replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim();

async function probeWorkable(slug) {
  const body = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
  if (body === null) return null;
  if (typeof body.name !== "string" || !Array.isArray(body.jobs)) {
    tally("workable", "unparseable");
    return null;
  }
  // Workable answers for names with no open jobs at all (Klarna, Ericsson...), which is no use to us.
  if (body.jobs.length === 0) return null;
  return { boardName: body.name, jobs: body.jobs.map((job) => ({ title: String(job.title ?? ""), text: "" })) };
}

async function probeRecruitee(slug) {
  const body = await getJson(`https://${slug}.recruitee.com/api/offers/`);
  if (body === null) return null;
  if (!Array.isArray(body.offers)) {
    tally("recruitee", "unparseable");
    return null;
  }
  if (body.offers.length === 0) return null;
  return { jobs: body.offers.map((offer) => ({ title: String(offer.title ?? ""), text: plain(offer.description) })) };
}

async function probeSmartRecruiters(id) {
  const body = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(id)}/postings?limit=100`);
  if (body === null) return null;
  if (!Array.isArray(body.content)) {
    tally("smartrecruiters", "unparseable");
    return null;
  }
  if (body.content.length === 0) return null;
  const name = body.content[0]?.company?.name;
  return {
    ...(typeof name === "string" ? { boardName: name } : {}),
    jobs: body.content.map((job) => ({ title: String(job.name ?? ""), text: "" })),
    total: Number(body.totalFound) || body.content.length,
  };
}

async function probePersonio(slug) {
  for (const host of [`${slug}.jobs.personio.de`, `${slug}.jobs.personio.com`]) {
    const result = await get(`https://${host}/xml?language=en`, "application/xml, text/xml;q=0.9");
    if (result === null) continue;
    if (!/<workzag-jobs[\s>]/i.test(result.text.slice(0, 3000))) {
      if (/\.personio\.(?:de|com)$/i.test(new URL(result.url).hostname)) tally("personio", "unparseable");
      continue;
    }
    const jobs = [...result.text.matchAll(/<position>([\s\S]*?)<\/position>/gi)].map((match) => ({
      title: cleanXml(/<name>([\s\S]*?)<\/name>/i.exec(match[1])?.[1]),
      text: plain(match[1]),
    }));
    if (jobs.length === 0) return null;
    return { jobs };
  }
  return null;
}

async function probe(system, slug) {
  switch (system) {
    case "greenhouse": return probeGreenhouse(slug);
    case "lever": return probeLever(slug, "api.lever.co");
    case "lever-eu": return probeLever(slug, "api.eu.lever.co");
    case "ashby": return probeAshby(slug);
    case "teamtailor": return probeTeamtailor(slug);
    case "workable": return probeWorkable(slug);
    case "recruitee": return probeRecruitee(slug);
    case "smartrecruiters": return probeSmartRecruiters(slug);
    case "personio": return probePersonio(slug);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// One company
// ---------------------------------------------------------------------------

const CRAWLABLE = ["greenhouse", "lever", "ashby", "teamtailor", "recruitee", "smartrecruiters"];
// Workday is deliberately not probed: it answers automated requests with HTTP 406.
const OTHER_SYSTEMS = ["workable", "personio"];

/** "Volvo Cars" -> "VolvoCars": SmartRecruiters company ids keep their capitals. */
function casedIds(company) {
  return nameVariants(company)
    .map((name) => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, ""))
    .filter((id) => id.length >= 2);
}

export async function discoverCompany(company, probeFn = probe, systems = CRAWLABLE) {
  const variants = nameVariants(company);
  const verified = [];
  const review = [];

  for (const slug of slugCandidates(company)) {
    for (const system of systems) {
      const ids = system === "smartrecruiters" ? [...new Set([slug, ...casedIds(company).filter((id) => id.toLowerCase() === slug)])] : [slug];
      for (const id of ids) {
        let found = await probeFn(system, id);
        let ats = system;
        if (found === null && system === "lever") {
          found = await probeFn("lever-eu", id);
          if (found !== null) ats = "lever-eu";
        }
        if (found === null) continue;
        tally(ats, "found");

        const how = verifyBoard(variants, found);
        const entry = {
          company: company.name,
          ats,
          slug: id,
          jobs: found.total ?? found.jobs.length,
          targetJobs: found.jobs.filter((job) => TARGET_TITLE.test(job.title)).length,
          ...(found.boardName === undefined ? {} : { boardName: found.boardName }),
          ...(found.extra ?? {}),
          sampleTitles: found.jobs.slice(0, 3).map((job) => job.title),
        };
        if (how === null) review.push(entry);
        else verified.push({ ...entry, verified: how });
        break;
      }
    }
    if (verified.length > 0) break;
  }
  return { verified, review };
}

// ---------------------------------------------------------------------------
// Files and report
// ---------------------------------------------------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const SYSTEM_NAMES = {
  workable: "Workable",
  recruitee: "Recruitee",
  smartrecruiters: "SmartRecruiters",
  personio: "Personio",
};

export function buildReport(companies, state, now = new Date()) {
  const others = state.others ?? [];
  const byCompany = new Map();
  for (const board of state.boards) byCompany.set(board.company, [...(byCompany.get(board.company) ?? []), board]);
  const reviewBy = new Map();
  for (const entry of state.needsReview) reviewBy.set(entry.company, [...(reviewBy.get(entry.company) ?? []), entry]);
  const othersBy = new Map();
  for (const entry of others) othersBy.set(entry.company, [...(othersBy.get(entry.company) ?? []), entry]);

  const crawled = state.boards.slice().sort((a, b) => b.targetJobs - a.targetJobs || b.jobs - a.jobs);
  const manualNames = new Set(state.manual.map((entry) => entry.company));
  const notFound = companies.filter(
    (company) =>
      !byCompany.has(company.name) && !reviewBy.has(company.name) && !manualNames.has(company.name) && !othersBy.has(company.name),
  );
  const totalJobs = crawled.reduce((sum, board) => sum + board.jobs, 0);
  const totalTarget = crawled.reduce((sum, board) => sum + board.targetJobs, 0);
  const esc = (text) => String(text).replace(/\|/g, "\\|");

  const perSystem = Object.keys(SYSTEM_NAMES).map((system) => {
    const rows = others.filter((entry) => entry.ats === system);
    const sure = new Set(rows.filter((entry) => entry.verified).map((entry) => entry.company)).size;
    const unsure = new Set(rows.filter((entry) => !entry.verified).map((entry) => entry.company)).size;
    return { system, sure, unsure };
  });
  const sureTotal = new Set(others.filter((entry) => entry.verified).map((entry) => entry.company)).size;
  const unsureOnly = [...othersBy.keys()].filter((name) => !othersBy.get(name).some((entry) => entry.verified)).length;

  const lines = [
    `# Company career boards`,
    ``,
    `Generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC from config/companies.json (${companies.length} companies).`,
    ``,
    `- **${byCompany.size} companies** have a confirmed board that every sync now crawls (${crawled.length} boards, ${totalJobs} open jobs, ${totalTarget} with a title that looks like one of your target roles; the sync's language and location filters then decide what is kept).`,
    `- **${reviewBy.size} companies** have a board that could not be confirmed (see "Needs your review").`,
    ...(others.length > 0
      ? [
          `- **${othersBy.size} more companies** use Workable or Personio (${sureTotal} confirmed, ${unsureOnly} possible). The site cannot crawl these yet (see "Found on other systems").`,
        ]
      : []),
    `- **${notFound.length} companies** were not found on any of the supported systems. They probably use another system or their own site.`,
    ``,
    `## Crawled by your site`,
    ``,
    `| Company | System | Board | Open jobs | Target-role titles | Confirmed by |`,
    `| --- | --- | --- | ---: | ---: | --- |`,
    ...crawled.map(
      (board) => `| ${esc(board.company)} | ${board.ats} | ${esc(board.slug)} | ${board.jobs} | ${board.targetJobs} | ${board.verified} |`,
    ),
    ``,
    `## Needs your review`,
    ``,
    `A board with this name exists but nothing proves it is the same company. Open the board, and if it is right, copy its company, ats and slug into the "manual" list in config/company-boards.json.`,
    ``,
    `| Company | System | Board | Board's own name | Open jobs | Example jobs |`,
    `| --- | --- | --- | --- | ---: | --- |`,
    ...state.needsReview
      .filter((entry) => !manualNames.has(entry.company))
      .map(
        (entry) =>
          `| ${esc(entry.company)} | ${entry.ats} | ${esc(entry.slug)} | ${esc(entry.boardName ?? "")} | ${entry.jobs} | ${esc(entry.sampleTitles.join("; "))} |`,
      ),
    ``,
  ];

  if (others.length > 0) {
    lines.push(
      `## Found on other systems (not crawled yet)`,
      ``,
      `| System | Companies confirmed | Companies possible (check by hand) |`,
      `| --- | ---: | ---: |`,
      ...perSystem.map((row) => `| ${SYSTEM_NAMES[row.system]} | ${row.sure} | ${row.unsure} |`),
      ``,
      `| Company | System | Board | Open jobs | Target-role titles (first page) | Status | Example jobs |`,
      `| --- | --- | --- | ---: | ---: | --- | --- |`,
      ...others
        .slice()
        .sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)) || b.jobs - a.jobs)
        .map(
          (entry) =>
            `| ${esc(entry.company)} | ${SYSTEM_NAMES[entry.ats] ?? entry.ats} | ${esc(entry.host ?? entry.slug)}${entry.site ? esc(`/${entry.site}`) : ""} | ${entry.jobs} | ${entry.targetJobs} | ${entry.verified ? `confirmed (${entry.verified})` : "possible"} | ${esc(entry.sampleTitles.join("; "))} |`,
        ),
      ``,
    );
  }

  lines.push(
    `## Not found on the supported systems`,
    ``,
    ...notFound.map(
      (company) => `- ${company.name} (${company.country}): [search careers](https://www.google.com/search?q=${encodeURIComponent(`${company.name} careers`)})`,
    ),
    ``,
  );
  return lines.join("\n");
}

async function save(state, companies, startedAt) {
  const output = {
    _readme: state._readme,
    version: 1,
    generatedAt: new Date().toISOString(),
    boards: state.boards,
    manual: state.manual,
    needsReview: state.needsReview,
    checked: state.checked,
    others: state.others,
    checkedOthers: state.checkedOthers,
  };
  await writeFile(BOARDS_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(REPORT_FILE), { recursive: true });
  await writeFile(REPORT_FILE, buildReport(companies, output, startedAt), "utf8");
}

function parseArgs(argv) {
  const args = { force: false, others: false, only: null, limit: Infinity, probe: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--force") args.force = true;
    else if (argv[index] === "--others") args.others = true;
    else if (argv[index] === "--probe") args.probe = String(argv[++index] ?? "");
    else if (argv[index] === "--only") args.only = String(argv[++index] ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
    else if (argv[index] === "--limit") args.limit = Number(argv[++index]) || Infinity;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.probe !== null) {
    // Diagnostic: ask one system about one board name and show every request made, e.g. --probe workable:huggingface
    const [system, ...rest] = args.probe.split(":");
    const slug = rest.join(":");
    if (!slug) {
      console.error('Use --probe system:name, e.g. --probe workable:huggingface (systems: greenhouse, lever, lever-eu, ashby, teamtailor, workable, recruitee, smartrecruiters, personio).');
      process.exitCode = 1;
      return;
    }
    trace = [];
    const found = await probe(system, slug);
    console.log(trace.join("\n"));
    if (found === null) console.log("RESULT: nothing found");
    else {
      const { jobs, ...rest2 } = found;
      console.log("RESULT:", JSON.stringify({ ...rest2, jobs: jobs.length, sampleTitles: jobs.slice(0, 3).map((job) => job.title) }, null, 2));
    }
    return;
  }

  const companies = (await readJson(COMPANIES_FILE, { companies: [] })).companies;
  if (!Array.isArray(companies) || companies.length === 0) {
    console.error("config/companies.json has no companies.");
    process.exitCode = 1;
    return;
  }
  const saved = await readJson(BOARDS_FILE, {});
  const state = {
    _readme: saved._readme ?? "",
    boards: Array.isArray(saved.boards) ? saved.boards : [],
    manual: Array.isArray(saved.manual) ? saved.manual : [],
    needsReview: Array.isArray(saved.needsReview) ? saved.needsReview : [],
    checked: saved.checked && typeof saved.checked === "object" ? saved.checked : {},
    others: Array.isArray(saved.others) ? saved.others : [],
    checkedOthers: saved.checkedOthers && typeof saved.checkedOthers === "object" ? saved.checkedOthers : {},
  };

  // --others only looks at companies that have no board the site can already crawl.
  const covered = new Set([...state.boards.map((board) => board.company), ...state.manual.map((entry) => entry.company)]);
  const checkedMap = args.others ? state.checkedOthers : state.checked;
  const now = Date.now();
  const stale = (name) => {
    const when = Date.parse(checkedMap[name] ?? "");
    return Number.isNaN(when) || now - when > RECHECK_DAYS * 86_400_000;
  };
  const pool = args.others ? companies.filter((company) => !covered.has(company.name)) : companies;
  let queue = pool.filter((company) =>
    args.only !== null ? args.only.includes(company.name.toLowerCase()) : args.force || stale(company.name),
  );
  queue = queue.slice(0, args.limit);

  const what = args.others ? "companies without a crawlable board (looking for Workable, Personio)" : "companies";
  console.log(`Checking ${queue.length} of ${pool.length} ${what}; the rest were checked within the last ${RECHECK_DAYS} days or are outside this run.`);
  if (queue.length === 0) {
    await save(state, companies, new Date());
    console.log(`Nothing to do. Report: ${REPORT_FILE}`);
    return;
  }

  const startedAt = new Date();
  let done = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nStopping after the current companies; progress is saved. Press Ctrl+C again to quit now.");
  });

  let next = 0;
  const worker = async () => {
    while (!stopping && next < queue.length) {
      const company = queue[next];
      next += 1;
      const { verified, review } = await discoverCompany(company, probe, args.others ? OTHER_SYSTEMS : CRAWLABLE);

      if (args.others) {
        const entries = verified.length > 0 ? verified : review;
        state.others = state.others.filter((entry) => entry.company !== company.name).concat(entries);
        state.checkedOthers[company.name] = new Date().toISOString();
      } else {
        state.boards = state.boards.filter((board) => board.company !== company.name).concat(verified);
        state.needsReview = state.needsReview.filter((entry) => entry.company !== company.name).concat(verified.length > 0 ? [] : review);
        state.checked[company.name] = new Date().toISOString();
      }
      done += 1;

      const label = `[${done}/${queue.length}] ${company.name}`;
      const describe = (entry) => `${entry.ats}:${entry.host ?? entry.slug} (${entry.jobs} jobs, ${entry.targetJobs} target)`;
      if (verified.length > 0) console.log(`${label}: ${verified.map(describe).join(", ")}`);
      else if (review.length > 0) console.log(`${label}: possible ${review.map(describe).join(", ")} - ${args.others ? "check by hand" : "needs review"}`);
      else console.log(`${label}: not found`);
      if (done % 10 === 0) await save(state, companies, startedAt);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await save(state, companies, startedAt);
  if (args.others) {
    const sure = new Set(state.others.filter((entry) => entry.verified).map((entry) => entry.company)).size;
    const all = new Set(state.others.map((entry) => entry.company)).size;
    console.log(`\nDone. ${all} companies were found on other systems (${sure} confirmed, ${all - sure} possible). Nothing was added to the crawl.`);
    for (const system of Object.keys(SYSTEM_NAMES)) {
      const row = stats[system] ?? { found: 0, unparseable: 0 };
      console.log(`  ${SYSTEM_NAMES[system]}: ${row.found} boards found${row.unparseable > 0 ? `, ${row.unparseable} answers I could not read (the format may differ from what I expected)` : ""}`);
    }
  } else {
    const crawled = new Set(state.boards.map((board) => board.company)).size;
    console.log(`\nDone. ${crawled} companies have a confirmed board, ${new Set(state.needsReview.map((entry) => entry.company)).size} need review.`);
    console.log("Start the site (npm run dev) and press Sync, or wait for the background sync: the boards are crawled automatically.");
  }
  console.log(`List: ${REPORT_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

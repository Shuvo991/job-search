# Job search (local-first job board, ATS analyzer, application tracker)

Next.js (App Router, TypeScript) + Tailwind + SQLite via Prisma + local Ollama. See `CLAUDE.md` for project rules.

## First-time setup (PowerShell, in this folder)

```powershell
npm install next@latest react@latest react-dom@latest zod@latest dotenv @prisma/client@7 @prisma/adapter-better-sqlite3@7
npm install -D typescript @types/node @types/react @types/react-dom @types/better-sqlite3 prisma@7 vitest tailwindcss @tailwindcss/postcss

npx prisma migrate dev --name init   # creates data/dev.db and the first migration
npm run verify                       # validate schema, migration status, typecheck, tests, build
npm run dev
```

`.env` is already created from `.env.example` (and is gitignored).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js (runs `prisma generate` first for dev/build) |
| `npm run typecheck` | `tsc --noEmit` with strict settings |
| `npm test` | Vitest (unit + API route tests) |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:status` | `prisma migrate status` |
| `npm run db:seed` | Adds 5 sample jobs (safe to re-run; existing jobs are skipped) |
| `npm run db:prune-geo` | Lists imported jobs that break the location rule (add `-- --apply` to remove them) |
| `npm run discover:boards` | Finds the Greenhouse/Lever/Ashby/Teamtailor job boards of the companies in `config/companies.json` and writes `config/company-boards.json` plus `data/company-boards-report.md`; every sync then crawls them (`-- --force` rechecks all, `-- --only "Klarna,King"` checks some, `-- --others` only *detects* Workable and Personio boards (Greenhouse, Lever, Ashby, Teamtailor, Recruitee and SmartRecruiters are crawled) for the companies not found yet; nothing extra is crawled) |
| `npm run verify` | Everything above, end to end |

## Layout

- `prisma/` schema + migrations (Job, UserProfile, Application, ApplicationEvent, GeneratedDocument)
- `config/` ATS rules JSON and coach prompts (editable without code changes)
- `src/lib/` db client, env validation, error classes, `withApiHandler`, Zod request helpers
- `src/schemas/` Zod schemas for every API input
- `src/app/` pages, error boundaries (`error.tsx`, `global-error.tsx`), `api/health`
- `tests/` Vitest

## Job board (Phase 2)

Open http://localhost:3000 after `npm run db:seed` and `npm run dev`.

- **Browse and filter** (`/`): free-text search, role type, location, work mode, level and skills. Filters live in the URL (`?q=...&skill=SQL&skill=Docker`), so results can be bookmarked and the back button works. Press **Apply filters** to search.
- **Add a job**: the *Add job* button opens a dialog with two modes.
  - *Structured*: fill in the fields. Skills you type are used as-is; leave the box empty (or press *Detect skills*) to have them extracted from the description.
  - *Paste a posting*: paste the raw text or HTML. Markup is stripped, and the role, level, work mode, skills and requirements are detected for you. A URL is stored as the posting link and is **never fetched** by the server.
- **Skill extractor**: `src/lib/skills-extractor.ts` matches text against `config/skills-dictionary.json` (about 400 technical and soft skills). It is plain regex matching, with no AI and no network. To teach it a new skill or alias, edit the JSON file; `tests/unit/skills-extractor.test.ts` checks the dictionary for duplicates and bad patterns.
- **API**: `GET /api/jobs` (same filters as the page) and `POST /api/jobs` (`{ "mode": "structured" | "raw", ... }`), both validated with Zod.
- **Safety**: pasted text is reduced to plain text by `src/lib/sanitize.ts` before it is stored, and it is rendered only as React text. The CSP in `next.config.ts` is a second layer.


## Job feeds (English-only import)

The **Sync English jobs** button on the board pulls jobs from the sources in `config/job-feeds.json`,
keeps only English-language ads for the roles this board lists, and reports per feed how many jobs were
imported and how many were filtered out. **Feed status** shows each source's last run, any error, and when it
may be synced again.

**Automatic sync.** While the app is running (`npm run dev` or `npm start`) it syncs on its own: the first
time about 30 seconds after start-up, then every 3 hours. Progress shows in the terminal as `[auto-sync] ...`
lines. Nothing runs while the app is closed. It uses the same code as the button, so each feed's cooldown still
applies and restarting the app does not cause extra requests. Change the timing under `settings.autoSync` in
`config/job-feeds.json`, turn it off with `"enabled": false`, or start the app with the environment variable
`AUTO_SYNC=off` (PowerShell: `$env:AUTO_SYNC="off"; npm run dev`). Restart the server after changing the config.

```
fetch -> parse (JSON / RSS 2.0 / Atom) -> sanitise HTML -> language check (franc-min)
      -> required-language phrases -> role check -> location check -> de-duplicate -> extract skills -> store
```

- **Sources** (`config/job-feeds.json`): Arbetsförmedlingen JobTech, Jobicy, Startup Jobs, Himalayas and
  Teamtailor career sites are on; Dev Global Jobs, Greenhouse and Lever are present but off (see the `terms`
  note on each). Add a source by copying an entry; field mappings use dotted paths (`employer.name`).
  A Swedish company that uses Teamtailor is one more line under the `teamtailor` feed's `instances`.
- **English only** (`config/language-rules.json`): step A detects the language of title + description; step B
  rejects ads containing phrases such as `flytande svenska`, `krav på svenska` or `fließend Deutsch` even when the
  rest is English. Add phrases freely; matching ignores case, accents and punctuation.
- **Europe, or remote and open worldwide** (`config/geo-rules.json`): on-site, hybrid and unknown-mode jobs
  must be in a European place (country, city, or "Europe" / "EMEA" / "Nordics"). Remote jobs are kept when the
  location says worldwide or anywhere, or when they are tied to Europe (including lists such as
  "EMEA, USA, Canada"). Remote jobs limited to the USA, India, APAC and so on are dropped, as are remote jobs
  whose description says candidates must live in or be authorised for one non-European country. A remote job
  with no location is dropped unless its feed says an empty location means worldwide (`worldwideWhenNoLocation`,
  set for Remote OK) or the description says "work from anywhere". Switches under `policy` in the file:
  `remoteTiedToEurope` (`keep` / `reject`), `unspecifiedRemote` (`keep` / `reject`), `checkDescription`.
  Turkey, Russia and Belarus are not in the Europe lists; add them if you want them. Jobs already on the board
  from before this rule can be cleared with `npm run db:prune-geo` (a dry run), then `npm run db:prune-geo -- --apply`;
  jobs you added yourself, the sample jobs and anything you applied for are never removed.
- **Country and City filters on the board**: pick a country (Sweden also finds Stockholm, Göteborg and jobs stored
  as "Sverige"), then a city; the City list only holds cities of the chosen country, and cities are merged across
  spellings (Gothenburg / Göteborg). `Europe-wide remote` and `Worldwide remote` are listed under Regions. The
  country, city and region lists are `europe.countryGroups` and `europe.regionSearchTerms` in
  `config/geo-rules.json`; `?country=Sweden&city=Stockholm` works in the address bar too.
- **Safety**: feed HTML goes through `sanitize-html` (only paragraph, list and heading tags survive, no
  attributes, no images or links) and then the plain-text sanitiser. Feeds are fetched over https only, from the
  hosts listed for that feed, with a timeout and a size cap; redirects are checked the same way. The XML reader
  refuses DTDs and never expands entities.
- **Duplicates**: each job is fingerprinted by company + title + canonical link (tracking parameters removed),
  so syncing again never creates copies. The link is stored as `sourceUrl`; the credit line a source requires
  (for example "Jobs via Jobicy") is stored as `attribution` and shown on the job page.
- **Rate limits**: each feed has a minimum interval (`minIntervalMinutes`); a failed feed is retried after 5
  minutes. Only one sync runs at a time. `POST /api/jobs/sync` accepts `{ "feedIds": [...] }` and
  `GET /api/jobs/sync` lists feeds with their last run.
- **Not stored**: ads for roles outside the board's categories (for example sales or design) are counted as
  "other roles" and skipped.

First-time setup for this feature (PowerShell, in this folder):

```powershell
npm install franc-min sanitize-html
npm install -D @types/sanitize-html
npx prisma migrate dev --name add_feed_ingestion   # adds Job.attribution and the feed_sync_logs table
npm run verify
```

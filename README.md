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

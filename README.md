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
| `npm run verify` | Everything above, end to end |

## Layout

- `prisma/` schema + migrations (Job, UserProfile, Application, ApplicationEvent, GeneratedDocument)
- `config/` ATS rules JSON and coach prompts (editable without code changes)
- `src/lib/` db client, env validation, error classes, `withApiHandler`, Zod request helpers
- `src/schemas/` Zod schemas for every API input
- `src/app/` pages, error boundaries (`error.tsx`, `global-error.tsx`), `api/health`
- `tests/` Vitest

# Project Rules & Architecture
- **Stack:** Next.js (App Router, TypeScript), Tailwind CSS, SQLite (via Prisma or Drizzle) for local database storage, Ollama (`http://localhost:11434`) for local LLM inference.
- **Zero External AI APIs:** Never import or call Anthropic, OpenAI, or any paid cloud LLM SDKs inside the application runtime. All AI tailoring must route through our local Ollama service wrapper.
- **Modular Configs:** Keep ATS rules in `/config/ats-rules.json` and coach system prompts in `/config/prompts/*.md` so they can be updated without changing code.
- **Security Standards:** Strictly sanitize all user inputs (Zod validation on every API route), prevent SQL injection via parameterized ORM queries, sanitize HTML/Markdown rendering to prevent XSS, and validate uploaded files (MIME type + size limits).
- **Testing & QA:** Write unit tests (Vitest) for all ATS scoring functions and integration tests for API routes.

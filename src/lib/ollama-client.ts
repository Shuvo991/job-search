/**
 * Local LLM client for Ollama (http://localhost:11434 by default).
 *
 * Project rules this file enforces (see CLAUDE.md):
 *  - Zero external AI APIs: the base URL is validated as a localhost address in `env.ts`, redirects
 *    are refused, and nothing here talks to any cloud provider.
 *  - Structured output only: every generation passes a JSON Schema in Ollama's `format` field (so the
 *    model is constrained while it decodes) AND the reply is validated again with Zod, because a
 *    schema-constrained model can still produce the wrong *content*. One repair retry is attempted.
 *  - Graceful degradation: "Ollama is not running" and "the model is not installed" are typed errors
 *    with setup steps, and `checkOllama()` never throws, so the UI can show a helpful panel instead
 *    of a stack trace.
 *
 * Server-side only. The browser never calls Ollama (the CSP `connect-src` is 'self').
 */
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tried (in this order) when the configured model is not installed. */
export const FALLBACK_MODEL_FAMILIES = ["llama3.2", "qwen2.5"] as const;

const STATUS_TIMEOUT_MS = 3_000;
const DEFAULT_TEMPERATURE = 0.2;
const MAX_ATTEMPTS = 2;
/** Ollama keeps the model in memory this long after a request, so the second document is fast. */
const KEEP_ALIVE = "10m";

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  numCtx: number;
  numPredict: number;
}

export function getOllamaConfig(): OllamaConfig {
  const env = getEnv();
  return {
    baseUrl: env.OLLAMA_BASE_URL.replace(/\/+$/, ""),
    model: env.OLLAMA_MODEL,
    timeoutMs: env.OLLAMA_TIMEOUT_MS,
    numCtx: env.OLLAMA_NUM_CTX,
    numPredict: env.OLLAMA_NUM_PREDICT,
  };
}

// ---------------------------------------------------------------------------
// Errors (all safe to show to the client; none carries a stack or a path)
// ---------------------------------------------------------------------------

/** Human-readable setup steps shown by the fallback UI when Ollama is not usable. */
export function ollamaSetupSteps(model: string): string[] {
  return [
    "Install Ollama from https://ollama.com/download (it runs locally, no account needed).",
    "Start it: open the Ollama app, or run `ollama serve` in a terminal.",
    model.startsWith("qwen2.5")
      ? `Download the model once: \`ollama pull ${model}\`.`
      : `Download a model once: \`ollama pull ${model}\` (for better CV rewriting, \`ollama pull qwen2.5:7b\`).`,
    "Come back here and press “Check again”.",
  ];
}

export class OllamaUnavailableError extends AppError {
  constructor(baseUrl: string, model: string, cause?: unknown) {
    super(503, "OLLAMA_UNAVAILABLE", "The local AI service (Ollama) is not running or not reachable.", {
      details: { baseUrl, model, steps: ollamaSetupSteps(model) },
      cause,
    });
  }
}

export class OllamaModelMissingError extends AppError {
  constructor(model: string, installed: readonly string[]) {
    super(
      503,
      "OLLAMA_MODEL_MISSING",
      `The AI model “${model}” is not installed in Ollama.`,
      { details: { model, installed, steps: [`Run \`ollama pull ${model}\`, then try again.`] } },
    );
  }
}

export class OllamaTimeoutError extends AppError {
  constructor(timeoutMs: number) {
    super(
      504,
      "OLLAMA_TIMEOUT",
      `The local model did not finish within ${Math.round(timeoutMs / 1000)} seconds. Try a smaller model, or raise OLLAMA_TIMEOUT_MS in .env.`,
    );
  }
}

export class OllamaOutputError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, "OLLAMA_BAD_OUTPUT", message, details === undefined ? {} : { details });
  }
}

export class PromptTooLongError extends AppError {
  constructor(estimatedTokens: number, budgetTokens: number) {
    super(
      422,
      "PROMPT_TOO_LONG",
      "The CV and job posting together are too long for the configured model context. Shorten the CV, or raise OLLAMA_NUM_CTX in .env (and use a model that supports it).",
      { details: { estimatedTokens, budgetTokens } },
    );
  }
}

/** The caller (the browser) went away or pressed Cancel. */
export class OllamaCancelledError extends AppError {
  constructor() {
    super(499, "REQUEST_CANCELLED", "The request was cancelled.");
  }
}

// ---------------------------------------------------------------------------
// Status check (never throws)
// ---------------------------------------------------------------------------

export interface OllamaStatus {
  available: boolean;
  baseUrl: string;
  configuredModel: string;
  /** The model that will be used, or null when none is usable. */
  activeModel: string | null;
  /** True when the configured model is not installed but a fallback family is. */
  usingFallback: boolean;
  installedModels: string[];
  reason: "ok" | "unreachable" | "no_models" | "model_missing";
  message: string;
  steps: string[];
}

const tagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string() })).default([]),
});

/** "llama3.2" and "llama3.2:latest" are the same model to Ollama. */
function withTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

function baseName(name: string): string {
  return name.split(":")[0] ?? name;
}

/**
 * Pick the installed model to use. An explicit request must match (exact, or the same family when no
 * tag was given). Without a request: the configured model, then the fallback families.
 */
export function pickModel(
  installed: readonly string[],
  requested: string | undefined,
  configured: string,
): { model: string | null; usingFallback: boolean } {
  const find = (wanted: string): string | undefined => {
    const exact = installed.find((name) => name === wanted || name === withTag(wanted));
    if (exact) return exact;
    // "llama3.2" with only "llama3.2:3b" installed: same family, accept it.
    return wanted.includes(":") ? undefined : installed.find((name) => baseName(name) === wanted);
  };

  if (requested !== undefined) {
    const hit = find(requested);
    return { model: hit ?? null, usingFallback: false };
  }
  const direct = find(configured);
  if (direct) return { model: direct, usingFallback: false };
  for (const family of FALLBACK_MODEL_FAMILIES) {
    const hit = find(family);
    if (hit) return { model: hit, usingFallback: true };
  }
  return { model: null, usingFallback: false };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function fetchInstalledModels(
  baseUrl: string,
  signal: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`, { signal, redirect: "error", cache: "no-store" });
  if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
  return tagsResponseSchema.parse(await res.json()).models.map((model) => model.name);
}

/** Ask Ollama what it has. Resolves with `available: false` (never rejects) when it cannot be used. */
export async function checkOllama(options: { requestedModel?: string } = {}): Promise<OllamaStatus> {
  const config = getOllamaConfig();
  const base = {
    baseUrl: config.baseUrl,
    configuredModel: config.model,
  };

  let installed: string[];
  try {
    installed = await fetchInstalledModels(config.baseUrl, AbortSignal.timeout(STATUS_TIMEOUT_MS));
  } catch {
    return {
      ...base,
      available: false,
      activeModel: null,
      usingFallback: false,
      installedModels: [],
      reason: "unreachable",
      message: "Ollama is not running, or it is not reachable at the configured address.",
      steps: ollamaSetupSteps(config.model),
    };
  }

  if (installed.length === 0) {
    return {
      ...base,
      available: false,
      activeModel: null,
      usingFallback: false,
      installedModels: [],
      reason: "no_models",
      message: "Ollama is running, but no models are installed yet.",
      steps: [`Run \`ollama pull ${config.model}\`, then press “Check again”.`],
    };
  }

  const { model, usingFallback } = pickModel(installed, options.requestedModel, config.model);
  if (model === null) {
    const wanted = options.requestedModel ?? config.model;
    return {
      ...base,
      available: false,
      activeModel: null,
      usingFallback: false,
      installedModels: installed,
      reason: "model_missing",
      message: `The model “${wanted}” is not installed.`,
      steps: [
        `Run \`ollama pull ${wanted}\`, or set OLLAMA_MODEL in .env to one of: ${installed.join(", ")}.`,
      ],
    };
  }

  return {
    ...base,
    available: true,
    activeModel: model,
    usingFallback,
    installedModels: installed,
    reason: "ok",
    message: usingFallback
      ? `The configured model “${config.model}” is not installed, so “${model}” will be used.`
      : `Ollama is ready (model “${model}”).`,
    steps: [],
  };
}

// ---------------------------------------------------------------------------
// Structured generation
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateStructuredOptions<S extends z.ZodType> {
  system: string;
  user: string;
  /** Zod schema for the reply. Its JSON Schema is sent to Ollama in `format`. */
  schema: S;
  /** A model the user picked in the UI. Must be installed; otherwise the configured one is used. */
  model?: string | undefined;
  temperature?: number;
  /** Aborts the generation (browser cancel / disconnect). */
  signal?: AbortSignal | undefined;
  /**
   * Cap on generated tokens for this call (default: OLLAMA_NUM_PREDICT). A one-bullet rewrite needs
   * about 100, so a low cap stops a model that rambles. num_ctx is deliberately NOT overridable:
   * Ollama reloads the model whenever num_ctx changes between requests, which costs more than it saves.
   */
  numPredict?: number;
  /** Time limit for this call in ms (default: OLLAMA_TIMEOUT_MS). */
  timeoutMs?: number;
  /** How many times to ask when the reply is invalid (default 2: one repair retry). */
  maxAttempts?: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  attempts: number;
  durationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
}

const chatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

/** One line of Ollama's streamed (NDJSON) reply: a piece of text, the final stats, or an error. */
const chatChunkSchema = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  error: z.string().optional(),
});

/**
 * Join Ollama's streamed reply into one response. We stream (instead of waiting for one big reply)
 * because Node's fetch gives up after 5 minutes without response headers, and a slow local model can
 * easily need longer than that to finish a whole CV. A plain single JSON object also parses (one line).
 */
export function parseChatStream(raw: string): z.infer<typeof chatResponseSchema> {
  let content = "";
  let doneReason: string | undefined;
  let promptEvalCount: number | undefined;
  let evalCount: number | undefined;
  let sawChunk = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const chunk = chatChunkSchema.parse(JSON.parse(trimmed));
    if (chunk.error !== undefined) throw new OllamaOutputError(`The local model returned an error: ${chunk.error.slice(0, 300)}`);
    sawChunk = true;
    content += chunk.message?.content ?? "";
    if (chunk.done_reason !== undefined) doneReason = chunk.done_reason;
    if (chunk.prompt_eval_count !== undefined) promptEvalCount = chunk.prompt_eval_count;
    if (chunk.eval_count !== undefined) evalCount = chunk.eval_count;
  }
  if (!sawChunk) throw new Error("empty response");
  return {
    message: { content },
    ...(doneReason !== undefined ? { done_reason: doneReason } : {}),
    ...(promptEvalCount !== undefined ? { prompt_eval_count: promptEvalCount } : {}),
    ...(evalCount !== undefined ? { eval_count: evalCount } : {}),
  };
}

const errorBodySchema = z.object({ error: z.string() });

/** Rough, deliberately pessimistic estimate (about 3 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** JSON Schema for Ollama's `format` field, derived from the Zod schema (single source of truth). */
export function toOllamaFormat(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete jsonSchema["$schema"];
  return jsonSchema;
}

/** Models sometimes wrap JSON in prose or fences despite `format`; take the outermost object. */
export function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim();
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Node's fetch hides the real reason in `err.cause` ("fetch failed" alone says nothing). */
function describeFetchFailure(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    parts.push(`${current.name}: ${current.message}${typeof code === "string" ? ` [${code}]` : ""}`);
    current = current.cause;
  }
  return (parts.join(" <- ") || String(err)).slice(0, 300);
}

async function chat(
  config: OllamaConfig,
  model: string,
  messages: ChatMessage[],
  format: Record<string, unknown>,
  temperature: number,
  callerSignal: AbortSignal | undefined,
): Promise<z.infer<typeof chatResponseSchema>> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        format,
        keep_alive: KEEP_ALIVE,
        options: { temperature, num_ctx: config.numCtx, num_predict: config.numPredict },
      }),
      signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch (err) {
    if (timeout.aborted) throw new OllamaTimeoutError(config.timeoutMs);
    if (callerSignal?.aborted || isAbortError(err)) throw new OllamaCancelledError();
    // The connection broke mid-request. If Ollama still answers, it is running but the generation
    // failed (typically out of memory or the model runner crashed): do not claim it is not running.
    const stillUp = await fetchInstalledModels(config.baseUrl, AbortSignal.timeout(STATUS_TIMEOUT_MS)).then(
      () => true,
      () => false,
    );
    if (stillUp) {
      const reason = describeFetchFailure(err);
      console.error(`[ollama] request to /api/chat failed while Ollama is up: ${reason}`);
      throw new OllamaOutputError(
        `Ollama is running but the generation request failed (${reason}). If this keeps happening, the model may have run out of memory: try a smaller model, or lower OLLAMA_NUM_CTX in .env.`,
        { cause: reason },
      );
    }
    throw new OllamaUnavailableError(config.baseUrl, model, err);
  }

  if (!res.ok) {
    let message = `Ollama answered HTTP ${res.status}.`;
    try {
      message = errorBodySchema.parse(await res.json()).error.slice(0, 300);
    } catch {
      // keep the generic message
    }
    if (res.status === 404 && /not found/i.test(message)) {
      throw new OllamaModelMissingError(model, []);
    }
    throw new OllamaOutputError(`The local model returned an error: ${message}`);
  }

  try {
    return parseChatStream(await res.text());
  } catch (err) {
    if (timeout.aborted) throw new OllamaTimeoutError(config.timeoutMs);
    if (callerSignal?.aborted) throw new OllamaCancelledError();
    if (err instanceof OllamaOutputError) throw err;
    throw new OllamaOutputError(
      `Ollama sent a response this app could not read (${describeFetchFailure(err)}). If it stopped midway, the model may have run out of memory.`,
      { cause: String(err) },
    );
  }
}

/**
 * Run one structured generation. Resolves with data that already passed `schema`, or throws one of the
 * typed errors above (Unavailable / ModelMissing / Timeout / Output / PromptTooLong / Cancelled).
 */
export async function generateStructured<S extends z.ZodType>(
  options: GenerateStructuredOptions<S>,
): Promise<StructuredResult<z.output<S>>> {
  const config: OllamaConfig = {
    ...getOllamaConfig(),
    ...(options.numPredict !== undefined ? { numPredict: options.numPredict } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_ATTEMPTS);
  const startedAt = Date.now();

  // Cheap guard first: a prompt that cannot fit the context window is silently truncated by Ollama,
  // which would cut the CV or the job posting without any error. Refuse instead.
  const inputTokens = estimateTokens(options.system) + estimateTokens(options.user);
  const budget = config.numCtx - config.numPredict;
  if (inputTokens > budget) throw new PromptTooLongError(inputTokens, budget);

  // Resolve the model against what is actually installed (also detects "Ollama is not running").
  const status = await checkOllama(options.model === undefined ? {} : { requestedModel: options.model });
  if (!status.available || status.activeModel === null) {
    if (status.reason === "unreachable" || status.reason === "no_models") {
      throw new OllamaUnavailableError(config.baseUrl, config.model);
    }
    throw new OllamaModelMissingError(options.model ?? config.model, status.installedModels);
  }
  const model = status.activeModel;

  const format = toOllamaFormat(options.schema);
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.user },
  ];

  let lastProblem = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reply = await chat(config, model, messages, format, temperature, options.signal);
    const content = reply.message.content;

    if (reply.done_reason === "length") {
      lastProblem = "the reply was cut off because it hit the output limit";
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonObject(content));
      } catch {
        parsed = undefined;
        lastProblem = "the reply was not valid JSON";
      }
      if (parsed !== undefined) {
        const result = options.schema.safeParse(parsed);
        if (result.success) {
          return {
            data: result.data,
            model,
            attempts: attempt,
            durationMs: Date.now() - startedAt,
            promptTokens: reply.prompt_eval_count ?? null,
            outputTokens: reply.eval_count ?? null,
          };
        }
        lastProblem = `the JSON did not match the schema (${describeIssues(result.error)})`;
      }
    }

    // Repair retry: show the model its own reply and what was wrong with it.
    if (attempt === maxAttempts) break;
    messages.push(
      { role: "assistant", content: content.slice(0, 20_000) },
      {
        role: "user",
        content: `Your previous reply was rejected: ${lastProblem}. Return the complete corrected JSON object only, matching the schema exactly.`,
      },
    );
  }

  throw new OllamaOutputError(
    `The local model did not return a usable answer after ${maxAttempts === 1 ? "one try" : `${maxAttempts} tries`}. Try again, or switch to a larger model (for example qwen2.5:7b).`,
    { reason: lastProblem },
  );
}

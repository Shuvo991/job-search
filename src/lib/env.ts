import { z } from "zod";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalUrl(value: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("file:./data/dev.db"),
  // Zero external AI APIs: the LLM endpoint must be a local Ollama service.
  OLLAMA_BASE_URL: z
    .string()
    .url()
    .refine(isLocalUrl, { message: "OLLAMA_BASE_URL must point to localhost" })
    .default("http://localhost:11434"),
  // Model used for CV / cover-letter tailoring. Any model you have pulled in Ollama works; llama3.2 and
  // qwen2.5 are the defaults the app looks for.
  OLLAMA_MODEL: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/, { message: "OLLAMA_MODEL contains invalid characters" })
    .default("llama3.2"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(900_000).default(240_000),
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2_048).max(131_072).default(16_384),
  OLLAMA_NUM_PREDICT: z.coerce.number().int().min(256).max(16_384).default(3_072),
  UPLOAD_DIR: z.string().min(1).default("./uploads"),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .default(5 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated environment, parsed lazily so a build does not require a .env file. */
export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

/** Test helper. */
export function resetEnvCache(): void {
  cached = undefined;
}

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

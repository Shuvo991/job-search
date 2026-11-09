import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetEnvCache } from "@/lib/env";
import {
  OllamaModelMissingError,
  OllamaOutputError,
  OllamaUnavailableError,
  PromptTooLongError,
  checkOllama,
  estimateTokens,
  extractJsonObject,
  generateStructured,
  pickModel,
  toOllamaFormat,
  parseChatStream,
} from "@/lib/ollama-client";

const schema = z.object({ title: z.string(), tags: z.array(z.string()) });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chatReply(content: string, extra: Record<string, unknown> = {}): Response {
  return json({ message: { role: "assistant", content }, done: true, done_reason: "stop", ...extra });
}

/** Routes /api/tags and /api/chat to canned replies and records every chat request body. */
function mockOllama(options: { models?: string[] | Error; chats?: Array<Response | Error> }) {
  const chats = [...(options.chats ?? [])];
  const chatBodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      if (options.models instanceof Error) throw options.models;
      return json({ models: (options.models ?? ["llama3.2:latest"]).map((name) => ({ name })) });
    }
    chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = chats.shift();
    if (next === undefined) throw new Error("unexpected extra chat request");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, chatBodies };
}

beforeEach(() => {
  resetEnvCache();
  vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
  vi.stubEnv("OLLAMA_MODEL", "llama3.2");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("pickModel", () => {
  it("matches 'llama3.2' to 'llama3.2:latest' and to another tag of the same family", () => {
    expect(pickModel(["llama3.2:latest"], undefined, "llama3.2").model).toBe("llama3.2:latest");
    expect(pickModel(["llama3.2:3b"], undefined, "llama3.2").model).toBe("llama3.2:3b");
  });

  it("falls back to llama3.2 or qwen2.5 when the configured model is not installed", () => {
    expect(pickModel(["qwen2.5:7b"], undefined, "mistral")).toEqual({ model: "qwen2.5:7b", usingFallback: true });
    expect(pickModel(["gemma3:4b"], undefined, "mistral")).toEqual({ model: null, usingFallback: false });
  });

  it("never substitutes another model when one was requested explicitly", () => {
    expect(pickModel(["llama3.2:latest"], "qwen2.5:7b", "llama3.2")).toEqual({ model: null, usingFallback: false });
  });
});

describe("checkOllama", () => {
  it("reports 'unreachable' with setup steps instead of throwing", async () => {
    mockOllama({ models: new TypeError("fetch failed") });
    const status = await checkOllama();
    expect(status).toMatchObject({ available: false, reason: "unreachable", activeModel: null });
    expect(status.steps.join(" ")).toContain("ollama pull llama3.2");
  });

  it("reports 'no_models' when Ollama runs but nothing is installed", async () => {
    mockOllama({ models: [] });
    expect(await checkOllama()).toMatchObject({ available: false, reason: "no_models" });
  });

  it("is ready when the configured model is installed", async () => {
    mockOllama({ models: ["llama3.2:latest", "qwen2.5:7b"] });
    expect(await checkOllama()).toMatchObject({ available: true, activeModel: "llama3.2:latest", usingFallback: false });
  });

  it("uses a fallback model and says so", async () => {
    vi.stubEnv("OLLAMA_MODEL", "mistral");
    resetEnvCache();
    mockOllama({ models: ["qwen2.5:7b"] });
    const status = await checkOllama();
    expect(status).toMatchObject({ available: true, activeModel: "qwen2.5:7b", usingFallback: true });
    expect(status.message).toContain("mistral");
  });
});

describe("generateStructured", () => {
  const request = { system: "You are a coach.", user: "Return JSON.", schema };

  it("sends the JSON Schema in `format`, pins the context window, and validates the reply", async () => {
    const { chatBodies } = mockOllama({ chats: [chatReply('{"title":"Hi","tags":["a"]}', { eval_count: 12 })] });
    const result = await generateStructured(request);

    expect(result.data).toEqual({ title: "Hi", tags: ["a"] });
    expect(result).toMatchObject({ model: "llama3.2:latest", attempts: 1, outputTokens: 12 });

    const body = chatBodies[0] as {
      model: string;
      stream: boolean;
      format: { type: string; properties: Record<string, unknown> };
      options: { num_ctx: number; temperature: number };
    };
    expect(body.model).toBe("llama3.2:latest");
    expect(body.stream).toBe(true);
    expect(body.format.type).toBe("object");
    expect(Object.keys(body.format.properties)).toEqual(["title", "tags"]);
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(4096);
  });

  it("retries once with the validation error when the first reply is unusable", async () => {
    const { chatBodies } = mockOllama({
      chats: [chatReply('{"title":"Hi"}'), chatReply('{"title":"Hi","tags":[]}')],
    });
    const result = await generateStructured(request);
    expect(result.attempts).toBe(2);
    const messages = (chatBodies[1] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.at(-1)?.content).toContain("rejected");
    expect(messages.at(-1)?.content).toContain("tags");
  });

  it("gives up with a clear error after two bad replies", async () => {
    mockOllama({ chats: [chatReply("not json"), chatReply("still not json")] });
    await expect(generateStructured(request)).rejects.toBeInstanceOf(OllamaOutputError);
  });

  it("honours a per-call output cap and a single attempt (used for one-bullet rewrites)", async () => {
    const { chatBodies, fetchMock } = mockOllama({ chats: [chatReply("not json")] });
    const error = await generateStructured({ ...request, numPredict: 200, maxAttempts: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OllamaOutputError);
    expect((error as OllamaOutputError).message).toContain("one try");
    expect((chatBodies[0] as { options: { num_predict: number } }).options.num_predict).toBe(200);
    // tags + exactly one chat call: no repair retry
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/chat"))).toHaveLength(1);
  });

  it("raises OllamaUnavailableError when Ollama is not running", async () => {
    mockOllama({ models: new TypeError("fetch failed") });
    const error = await generateStructured(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OllamaUnavailableError);
    expect((error as OllamaUnavailableError).status).toBe(503);
    expect((error as OllamaUnavailableError).code).toBe("OLLAMA_UNAVAILABLE");
  });

  it("raises OllamaModelMissingError for an explicit model that is not installed", async () => {
    mockOllama({ models: ["llama3.2:latest"] });
    await expect(generateStructured({ ...request, model: "qwen2.5:7b" })).rejects.toBeInstanceOf(OllamaModelMissingError);
  });

  it("refuses a prompt that cannot fit the context window instead of letting Ollama truncate it", async () => {
    const { fetchMock } = mockOllama({});
    await expect(generateStructured({ ...request, user: "x".repeat(60_000) })).rejects.toBeInstanceOf(PromptTooLongError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a reply cut off by the output limit as a failure, not as data", async () => {
    mockOllama({
      chats: [
        json({ message: { content: '{"title":"Hi","tags":["a"' }, done: true, done_reason: "length" }),
        chatReply('{"title":"Hi","tags":["a"]}'),
      ],
    });
    const result = await generateStructured(request);
    expect(result.attempts).toBe(2);
  });
});

describe("helpers", () => {
  it("extracts the outermost JSON object from a fenced reply", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("derives the Ollama format from the Zod schema without a $schema key", () => {
    expect(toOllamaFormat(schema)).not.toHaveProperty("$schema");
  });

  it("estimates tokens pessimistically", () => {
    expect(estimateTokens("abcdef")).toBe(2);
  });
});

describe("parseChatStream", () => {
  it("joins streamed pieces and keeps the final stats", () => {
    const raw = [
      JSON.stringify({ message: { content: '{"a":' }, done: false }),
      JSON.stringify({ message: { content: "1}" }, done: false }),
      JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 40, eval_count: 7 }),
      "",
    ].join("\n");
    expect(parseChatStream(raw)).toEqual({
      message: { content: '{"a":1}' },
      done_reason: "stop",
      prompt_eval_count: 40,
      eval_count: 7,
    });
  });

  it("still accepts a single JSON object", () => {
    const raw = JSON.stringify({ message: { content: "hello" }, done: true, done_reason: "stop" });
    expect(parseChatStream(raw).message.content).toBe("hello");
  });

  it("turns an error line in the stream into an OllamaOutputError", () => {
    const raw = [JSON.stringify({ message: { content: "x" } }), JSON.stringify({ error: "model runner stopped" })].join("\n");
    expect(() => parseChatStream(raw)).toThrow(/model runner stopped/);
  });

  it("rejects an empty body", () => {
    expect(() => parseChatStream("\n")).toThrow();
  });
});

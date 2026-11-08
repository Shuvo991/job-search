/**
 * Fetches one feed URL as text, with the safeguards an outbound request from a local app needs:
 *  - https only, no credentials in the URL, no custom ports
 *  - the host must be on the feed's allow-list (also for every redirect, which are followed by hand)
 *  - never an IP address, localhost or an internal-looking name (blocks server-side request forgery
 *    through a redirect or a mistyped config)
 *  - a timeout and a hard cap on the response size, enforced while streaming
 * The `fetch` implementation is injectable so tests never touch the network.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class FeedFetchError extends Error {
  readonly code: "blocked_url" | "http_status" | "too_large" | "timeout" | "network" | "too_many_redirects";

  constructor(code: FeedFetchError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FeedFetchError";
    this.code = code;
  }
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  allowedHosts: string[];
  accept: string;
  fetchImpl?: FetchLike;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

function hostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p;
  });
}

/** Throws FeedFetchError("blocked_url") unless the URL may be requested. Returns the parsed URL. */
export function assertFetchableUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedFetchError("blocked_url", "The feed URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new FeedFetchError("blocked_url", `Only https feeds are allowed (${url.protocol}).`);
  if (url.username !== "" || url.password !== "") throw new FeedFetchError("blocked_url", "Credentials in a feed URL are not allowed.");
  if (url.port !== "" && url.port !== "443") throw new FeedFetchError("blocked_url", "Custom ports are not allowed.");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const looksLikeIp = /^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[");
  if (looksLikeIp || INTERNAL_NAME.test(host) || !host.includes(".")) {
    throw new FeedFetchError("blocked_url", `Requests to ${host} are not allowed.`);
  }
  if (!hostAllowed(host, allowedHosts)) {
    throw new FeedFetchError("blocked_url", `${host} is not on this feed's allowed hosts.`);
  }
  return url;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FeedFetchError("too_large", `The response is larger than ${maxBytes} bytes.`);
  }

  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FeedFetchError("too_large", `The response is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchFeedText(rawUrl: string, options: FetchOptions): Promise<string> {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  let target = assertFetchableUrl(rawUrl, options.allowedHosts);

  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(target.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: options.accept, "user-agent": options.userAgent },
        signal: AbortSignal.timeout(options.timeoutMs),
        cache: "no-store",
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new FeedFetchError(
        timedOut ? "timeout" : "network",
        timedOut ? `No response from ${target.hostname} within ${options.timeoutMs / 1000}s.` : `Could not reach ${target.hostname}.`,
        { cause },
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null) throw new FeedFetchError("http_status", `${target.hostname} redirected without a location.`);
      target = assertFetchableUrl(new URL(location, target).toString(), options.allowedHosts);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FeedFetchError("http_status", `${target.hostname} answered HTTP ${response.status}.`);
    }

    try {
      return await readLimited(response, options.maxBytes);
    } catch (cause) {
      if (cause instanceof FeedFetchError) throw cause;
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new FeedFetchError(timedOut ? "timeout" : "network", `The download from ${target.hostname} was interrupted.`, { cause });
    }
  }

  throw new FeedFetchError("too_many_redirects", `Too many redirects from ${new URL(rawUrl).hostname}.`);
}

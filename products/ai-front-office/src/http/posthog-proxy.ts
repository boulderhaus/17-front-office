import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./security.js";

/** The browser SDKs talk to /ingest on our own origin, so the CSP stays 'self' and ad blockers keep events. */
export const POSTHOG_PROXY_PREFIX = "/ingest";

const MAX_PROXY_BODY_BYTES = 5_000_000;
const FORWARDED_REQUEST_HEADERS = ["content-type", "content-encoding", "user-agent", "accept", "accept-language"] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"] as const;

/**
 * The two upstream origins for a PostHog ingestion host, e.g. https://us.i.posthog.com
 * and https://us-assets.i.posthog.com. The host comes from validated config, never the request.
 */
export function posthogUpstreams(ingestionHost: string): { api: string; assets: string } {
  const api = new URL(ingestionHost);
  const assets = new URL(ingestionHost);
  assets.hostname = api.hostname.replace(/^([a-z]+)\.i\.posthog\.com$/, "$1-assets.i.posthog.com");
  return { api: api.origin, assets: assets.origin };
}

/**
 * Maps a request path under /ingest to its upstream URL, or null if it must not be forwarded.
 * The result is always on one of the two configured PostHog origins: no open proxy.
 */
export function posthogTargetUrl(pathAndQuery: string, ingestionHost: string): URL | null {
  if (!pathAndQuery.startsWith(`${POSTHOG_PROXY_PREFIX}/`)) return null;
  const rest = pathAndQuery.slice(POSTHOG_PROXY_PREFIX.length);
  // "//host", "/\\host", "/@host" and encoded dot segments are never valid PostHog paths.
  const path = rest.split("?", 1)[0]!;
  if (!/^\/[A-Za-z0-9]/.test(path) || /[\\@]|%2e|%2f|%5c|\/\.\.?(?:\/|$)/i.test(path)) return null;
  const { api, assets } = posthogUpstreams(ingestionHost);
  const origin = /^\/(?:static|array)\//.test(rest) ? assets : api;
  let target: URL;
  try {
    target = new URL(`${origin}${rest}`);
  } catch {
    return null;
  }
  return target.origin === origin ? target : null;
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PROXY_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function proxyToPostHog(
  request: IncomingMessage,
  response: ServerResponse,
  options: { ingestionHost: string; clientIp: string; fetcher: typeof fetch },
): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
  const target = posthogTargetUrl(request.url ?? "", options.ingestionHost);
  if (!target) throw new HttpError(404, "Not found");
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  // Cookies and authorization never leave our origin. The client IP keeps PostHog's geo lookup working.
  headers["x-forwarded-for"] = options.clientIp;
  const body = method === "POST" ? await readRawBody(request) : undefined;
  let upstream: Response;
  try {
    upstream = await options.fetcher(target, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  } catch {
    throw new HttpError(502, "Analytics upstream unavailable");
  }
  const payload = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders: Record<string, string | number> = { "content-length": payload.length };
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  // Redirects are not followed or passed on: the browser must never be sent off-origin.
  response.writeHead(upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status, responseHeaders);
  response.end(method === "HEAD" ? undefined : payload);
}

/**
 * Adds the public project key (and, for server-rendered pages, the same-site loader script)
 * to a page's <head>. Without a key the page is returned unchanged, so nothing loads or sends.
 */
export function injectAnalytics(html: string, options: { key: string | undefined; ingestionHost: string; loader: boolean }): string {
  if (!options.key || !/^phc_[A-Za-z0-9_-]+$/.test(options.key)) return html;
  const uiHost = options.ingestionHost.includes("://eu.") ? "https://eu.posthog.com" : "https://us.posthog.com";
  const tags = `<meta name="posthog-key" content="${options.key}"><meta name="posthog-ui-host" content="${uiHost}">${options.loader ? `<script src="/assets/analytics.js" defer></script>` : ""}`;
  return html.replace(/<head>/i, (head) => `${head}${tags}`);
}

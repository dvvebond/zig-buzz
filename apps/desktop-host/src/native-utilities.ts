const NIP11_LIMIT = 256 * 1024;
const JOIN_POLICY_LIMIT = 4 * 1024 * 1024;
const LINK_PREVIEW_LIMIT = 256 * 1024;
const HEX_PUBKEY = /^[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

export async function fetchRelaySelf(relayUrl: string): Promise<string | null> {
  try {
    const response = await fetchNip11(relayUrl);
    if (!response.ok) return null;
    const value = parseObjectJson(
      await readBoundedText(response, NIP11_LIMIT, "relay NIP-11 document"),
      "relay returned malformed NIP-11 document",
    );
    const relaySelf = value.self;
    return typeof relaySelf === "string" &&
      HEX_PUBKEY.test(relaySelf.toLowerCase())
      ? relaySelf.toLowerCase()
      : null;
  } catch {
    // NIP-11 relay identity is an optional UI affordance. An unreachable or
    // malformed relay must fail closed as "unknown", never as a trusted key.
    return null;
  }
}

export async function relayRequiresMembership(
  relayUrl: string,
): Promise<boolean> {
  const response = await fetchNip11(relayUrl);
  if (!response.ok) {
    throw new Error(`relay NIP-11 request failed (${response.status})`);
  }
  const value = parseObjectJson(
    await readBoundedText(response, NIP11_LIMIT, "relay NIP-11 document"),
    "relay returned malformed NIP-11 document",
  );
  return (
    Array.isArray(value.supported_nips) &&
    value.supported_nips.some((nip) => nip === 43)
  );
}

export async function fetchJoinPolicy(
  relayUrl: unknown,
): Promise<unknown | null> {
  const url = relayHttpUrl(relayUrl, "relay URL");
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/api/join-policy`;
  url.search = "";
  url.hash = "";
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = parseObjectJson(
    await readBoundedText(response, JOIN_POLICY_LIMIT, "join policy"),
    "relay returned malformed join policy",
  );
  return value.policy === undefined || value.policy === null
    ? null
    : value.policy;
}

export async function fetchWorkspaceIcon(
  relayUrl: unknown,
): Promise<string | null> {
  try {
    const response = await fetchNip11(requireString(relayUrl, "relayUrl"));
    if (!response.ok) return null;
    const value = parseObjectJson(
      await readBoundedText(response, NIP11_LIMIT, "relay NIP-11 document"),
      "relay returned malformed NIP-11 document",
    );
    return safeIconUrl(value.icon);
  } catch {
    return null;
  }
}

export async function fetchLinkPreviewTitle(
  href: unknown,
): Promise<string | null> {
  const value = requireString(href, "href").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid URL");
  }
  if (!isSupportedGoogleLink(url)) return null;
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Buzz Desktop link preview",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type");
  if (
    contentType !== null &&
    !contentType.toLowerCase().includes("text/html")
  ) {
    return null;
  }
  const html = await readBoundedText(
    response,
    LINK_PREVIEW_LIMIT,
    "link preview",
    true,
  );
  return extractGoogleTitle(html);
}

export function relayHttpUrl(value: unknown, name = "relayUrl"): URL {
  const raw = requireString(value, name).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid relay URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("relay URL must use ws:// or wss://");
  }
  if (url.username || url.password) {
    throw new Error("relay URL must not contain credentials");
  }
  if (url.hash) throw new Error("relay URL must not contain a fragment");
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new Error("remote relay URL must use wss://");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url;
}

async function fetchNip11(relayUrl: string): Promise<Response> {
  const url =
    relayUrl.startsWith("http:") || relayUrl.startsWith("https:")
      ? validatedHttpRelayUrl(relayUrl)
      : relayHttpUrl(relayUrl);
  url.search = "";
  url.hash = "";
  return fetch(url, {
    headers: { Accept: "application/nostr+json" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

function validatedHttpRelayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid relay URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("relay URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("relay URL must not contain credentials or a fragment");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("remote relay URL must use HTTPS");
  }
  return url;
}

export async function readBoundedBytes(
  response: Response,
  limit: number,
  label: string,
  truncate = false,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`${label} returned an invalid content length`);
    }
    if (size > limit && !truncate) {
      throw new Error(`${label} exceeds ${formatBytes(limit)}`);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - total;
      if (value.byteLength > remaining) {
        if (!truncate) {
          throw new Error(`${label} exceeds ${formatBytes(limit)}`);
        }
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (total === limit && !truncate) {
      const next = await reader.read();
      if (!next.done) {
        throw new Error(`${label} exceeds ${formatBytes(limit)}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readBoundedText(
  response: Response,
  limit: number,
  label: string,
  truncate = false,
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: false }).decode(
    await readBoundedBytes(response, limit, label, truncate),
  );
}

function parseObjectJson(text: string, message: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as JsonObject;
}

function safeIconUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512_000
  ) {
    return null;
  }
  if (
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)
  ) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopback(url.hostname)) {
    return url.toString();
  }
  return null;
}

function isSupportedGoogleLink(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "docs.google.com") {
    return (
      parts.length >= 3 &&
      ["document", "spreadsheets", "presentation"].includes(parts[0] ?? "") &&
      parts[1] === "d" &&
      (parts[2]?.length ?? 0) > 0
    );
  }
  if (host !== "drive.google.com") return false;
  return (
    (parts[0] === "file" && parts[1] === "d" && (parts[2]?.length ?? 0) > 0) ||
    (parts[0] === "drive" &&
      parts[1] === "folders" &&
      (parts[2]?.length ?? 0) > 0) ||
    (parts[0] === "open" && url.searchParams.has("id"))
  );
}

function extractGoogleTitle(html: string): string | null {
  let raw: string | null = null;
  for (const match of html.matchAll(/<meta\b[^>]{0,4096}>/gi)) {
    const tag = match[0];
    const property =
      htmlAttribute(tag, "property") ?? htmlAttribute(tag, "name");
    if (
      property?.toLowerCase() === "og:title" ||
      property?.toLowerCase() === "twitter:title"
    ) {
      raw = htmlAttribute(tag, "content");
      if (raw !== null) break;
    }
  }
  if (raw === null) {
    const title = /<title\b[^>]{0,1024}>([\s\S]{0,4096}?)<\/title>/i.exec(html);
    raw = title?.[1] ?? null;
  }
  if (raw === null) return null;
  let title = decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();
  title = title.replace(/ - Google (?:Docs|Sheets|Slides|Drive)$/, "").trim();
  const generic = new Set([
    "",
    "Document",
    "Spreadsheet",
    "Presentation",
    "Drive file",
    "Drive folder",
    "Google Docs",
    "Google Sheets",
    "Google Slides",
    "Google Drive",
    "Sign in - Google Accounts",
  ]);
  return generic.has(title) ? null : [...title].slice(0, 180).join("");
}

function htmlAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : decodeHtmlEntities(value);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d{1,7});/g, (_match, code: string) =>
      decodeEntityCode(Number(code)),
    )
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, code: string) =>
      decodeEntityCode(Number.parseInt(code, 16)),
    );
}

function decodeEntityCode(code: number): string {
  return Number.isSafeInteger(code) &&
    code > 0 &&
    code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : "\ufffd";
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function formatBytes(value: number): string {
  return value % (1024 * 1024) === 0
    ? `${value / (1024 * 1024)} MiB`
    : `${value} bytes`;
}

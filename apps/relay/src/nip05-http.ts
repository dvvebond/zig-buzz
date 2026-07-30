import type { IncomingMessage, ServerResponse } from "node:http";

import type { Pool } from "pg";

const LOCAL_PART = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Serve the public NIP-05 discovery document for the already host-bound
 * community. The lookup always joins through communities, so a handle on
 * another tenant can never be discovered through this endpoint.
 */
export async function handleNip05Http(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly community: string;
    readonly pool?: Pool;
    readonly publicUrl: URL;
  },
): Promise<boolean> {
  if (request.method !== "GET") return false;
  const url = new URL(request.url ?? "/", httpBaseUrl(input.publicUrl));
  if (url.pathname !== "/.well-known/nostr.json") return false;

  const name = url.searchParams.get("name");
  let pubkey: string | undefined;
  if (name && LOCAL_PART.test(name) && input.pool) {
    const handle = `${name.toLowerCase()}@${domain(input.community)}`;
    const result = await input.pool.query<{ readonly pubkey: string }>(
      `SELECT encode(u.pubkey, 'hex') AS pubkey
       FROM users u
       JOIN communities c ON c.id = u.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND u.deactivated_at IS NULL
         AND lower(u.nip05_handle) = lower($2)
       LIMIT 1`,
      [input.community, handle],
    );
    const candidate = result.rows[0]?.pubkey;
    if (/^[0-9a-f]{64}$/.test(candidate ?? "")) pubkey = candidate;
  }

  const advertisedRelay = relayUrl(input.publicUrl);
  response.statusCode = 200;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "public, max-age=60");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Host");
  response.end(
    JSON.stringify(
      pubkey
        ? {
            names: { [name!.toLowerCase()]: pubkey },
            relays: { [pubkey]: [advertisedRelay] },
          }
        : { names: {}, relays: {} },
    ),
  );
  return true;
}

export function canonicalizeNip05(
  value: string,
  community: string,
): string | null {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("@");
  if (
    separator < 1 ||
    separator !== trimmed.lastIndexOf("@") ||
    separator === trimmed.length - 1
  ) {
    return null;
  }
  const local = trimmed.slice(0, separator);
  const suppliedDomain = trimmed.slice(separator + 1).toLowerCase();
  const expectedDomain = domain(community);
  if (!LOCAL_PART.test(local) || suppliedDomain !== expectedDomain) {
    return null;
  }
  return `${local.toLowerCase()}@${expectedDomain}`;
}

function relayUrl(publicUrl: URL): string {
  const output = new URL(publicUrl);
  output.protocol = output.protocol === "wss:" ? "wss:" : "ws:";
  output.pathname = "/";
  output.search = "";
  output.hash = "";
  return output.toString().replace(/\/$/, "");
}

function domain(authority: string): string {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return authority
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(":")[0]!
      .toLowerCase();
  }
}

function httpBaseUrl(publicUrl: URL): URL {
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

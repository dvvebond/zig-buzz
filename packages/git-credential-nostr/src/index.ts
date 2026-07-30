import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { finalizeEvent, nip19, type Event } from "nostr-tools";

export interface CredentialRequest {
  readonly hasAuthtypeCapability: boolean;
  readonly protocol?: string;
  readonly host?: string;
  readonly path?: string;
  readonly wwwauth?: string;
}

export function parseCredentialRequest(input: string): CredentialRequest {
  let hasAuthtypeCapability = false;
  let protocol: string | undefined;
  let host: string | undefined;
  let path: string | undefined;
  let wwwauth: string | undefined;
  for (const line of input.split(/\r?\n/)) {
    if (line === "") break;
    if (line === "capability[]=authtype") hasAuthtypeCapability = true;
    else if (line.startsWith("protocol=")) protocol = line.slice(9);
    else if (line.startsWith("host=")) host = line.slice(5);
    else if (line.startsWith("path=")) path = line.slice(5);
    else if (line.startsWith("wwwauth[]=Nostr ") && wwwauth === undefined) {
      wwwauth = line.slice("wwwauth[]=".length);
    }
  }
  return {
    hasAuthtypeCapability,
    ...(protocol === undefined ? {} : { protocol }),
    ...(host === undefined ? {} : { host }),
    ...(path === undefined ? {} : { path }),
    ...(wwwauth === undefined ? {} : { wwwauth }),
  };
}

export function parseChallengeMethod(
  challenge: string,
): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined {
  const params = challenge.startsWith("Nostr ")
    ? challenge.slice("Nostr ".length)
    : challenge;
  for (const parameter of params.split(",")) {
    const match = /^\s*method="(GET|POST|PUT|PATCH|DELETE)"/.exec(parameter);
    if (match?.[1]) return match[1] as ReturnType<typeof parseChallengeMethod>;
  }
  return undefined;
}

export function canonicalRepositoryUrl(request: {
  readonly protocol: string;
  readonly host: string;
  readonly path: string;
}): string {
  if (!/^https?$/.test(request.protocol)) throw new Error("invalid protocol");
  if (
    request.host.includes("@") ||
    /[\r\n/?#]/.test(request.host) ||
    request.host.length > 255
  ) {
    throw new Error("invalid host");
  }
  let path = request.path;
  const refs = path.indexOf("/info/refs");
  if (refs >= 0) path = path.slice(0, refs);
  else {
    for (const suffix of ["/git-upload-pack", "/git-receive-pack"]) {
      if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
    }
  }
  if (path.startsWith("/") || path.includes("..") || /[\r\n?#]/.test(path)) {
    throw new Error("invalid credential path");
  }
  return new URL(`${request.protocol}://${request.host}/${path}`).toString();
}

export function parseSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  const decoded = nip19.decode(trimmed);
  if (decoded.type !== "nsec")
    throw new Error("expected nsec or lowercase hex key");
  return decoded.data;
}

export function createNip98Credential(input: {
  readonly secretKey: Uint8Array;
  readonly url: string;
  readonly method: string;
  readonly authTag?: readonly string[];
  readonly now?: number;
}): { readonly event: Event; readonly credential: string } {
  const tags: string[][] = [
    ["u", input.url],
    ["method", input.method],
  ];
  if (input.authTag) {
    if (
      input.authTag.length !== 4 ||
      input.authTag[0] !== "auth" ||
      input.authTag.some((part) => typeof part !== "string")
    ) {
      throw new Error(
        "invalid NIP-OA auth tag: expected [auth, owner, conditions, signature]",
      );
    }
    tags.push([...input.authTag]);
  }
  const event = finalizeEvent(
    {
      kind: 27_235,
      created_at: input.now ?? Math.floor(Date.now() / 1_000),
      content: "",
      tags,
    },
    input.secretKey,
  );
  return {
    event,
    credential: Buffer.from(JSON.stringify(event)).toString("base64"),
  };
}

export function loadSecretKey(
  env: NodeJS.ProcessEnv = process.env,
  config: (key: string) => string | undefined = gitConfig,
): Uint8Array {
  const fromEnv = env.NOSTR_PRIVATE_KEY;
  if (fromEnv) return parseSecretKey(fromEnv);
  const path = config("nostr.keyfile");
  if (!path) {
    throw new Error(
      "no nostr key configured. Set $NOSTR_PRIVATE_KEY or git config nostr.keyfile",
    );
  }
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`keyfile ${path} is not a regular file`);
  if (stat.size > 256)
    throw new Error(`keyfile ${path} exceeds 256-byte size limit`);
  if (process.platform !== "win32" && (stat.mode & 0o177) !== 0) {
    throw new Error(`keyfile ${path} has insecure permissions (expected 0600)`);
  }
  return parseSecretKey(readFileSync(path, "utf8"));
}

export function loadAuthTag(
  env: NodeJS.ProcessEnv = process.env,
  config: (key: string) => string | undefined = gitConfig,
): string[] | undefined {
  const raw = env.BUZZ_AUTH_TAG || config("nostr.authtag");
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== "auth" ||
    !parsed.every((part) => typeof part === "string")
  ) {
    throw new Error(
      "invalid NIP-OA auth tag: expected [auth, owner, conditions, signature]",
    );
  }
  return parsed;
}

function gitConfig(key: string): string | undefined {
  try {
    const value = execFileSync("git", ["config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      maxBuffer: 8_192,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

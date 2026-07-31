#!/usr/bin/env node

import { schnorr } from "@noble/curves/secp256k1.js";
import { resolvePack, validatePack } from "@buzz/persona";
import { nip19 } from "nostr-tools";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { executeCommand } from "./commands.js";
import { RelayApi } from "./relay-api.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const BOOLEAN_FLAGS = new Set([
  "allowEmpty",
  "approved",
  "broadcast",
  "clearTags",
  "contentOnly",
  "draft",
  "dryRun",
  "exact",
  "includeArchived",
  "json",
  "latest",
  "member",
  "noBaseHash",
  "noDelete",
  "noForcePush",
  "noTtl",
  "replace",
  "requirePatch",
  "restricted",
  "root",
  "rootRevision",
  "yes",
]);
const REPEATED_FLAGS = new Map([
  ["appliedAsCommit", "appliedAsCommits"],
  ["clone", "cloneUrls"],
  ["label", "labels"],
  ["maintainer", "maintainers"],
  ["nostrRelay", "relays"],
  ["pubkey", "pubkeys"],
  ["q", "appliedPatches"],
  ["tag", "tags"],
  ["to", "recipients"],
]);

type ParsedCli = {
  readonly action?: string;
  readonly authTag?: string;
  readonly flags: Record<string, unknown>;
  readonly format: "json" | "compact";
  readonly help: boolean;
  readonly input?: string;
  readonly privateKey?: string;
  readonly relay?: string;
  readonly resource?: string;
  readonly version: boolean;
};

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(helpText());
    return;
  }
  if (parsed.version) {
    process.stdout.write("buzz 0.4.26\n");
    return;
  }
  if (!parsed.resource || !parsed.action) {
    throw new TypeError("expected a resource and action; run buzz --help");
  }

  const input = await resolveInput(parsed);
  if (parsed.resource === "pack") {
    const value = objectInput(input);
    const packPath = requiredPath(value.path);
    const data =
      parsed.action === "validate"
        ? await validatePack(packPath)
        : parsed.action === "inspect"
          ? await resolvePack(packPath)
          : (() => {
              throw new TypeError(`unsupported command: pack ${parsed.action}`);
            })();
    await writeResult(data, parsed.format, parsed, input);
    return;
  }

  const relayUrl = websocketRelayUrl(
    parsed.relay ?? process.env.BUZZ_RELAY_URL ?? "http://localhost:3000/",
  );
  const secretKey = decodeSecretKey(
    parsed.privateKey ?? process.env.BUZZ_PRIVATE_KEY ?? process.env.BUZZ_NSEC,
  );
  const authTag = parseAndVerifyAuthTag(
    parsed.authTag ?? process.env.BUZZ_AUTH_TAG,
    secretKey,
  );
  const allowInsecureLocalhost = isLoopbackRelay(relayUrl);
  const relay = new RelayApi({
    allowInsecureLocalhost,
    ...(authTag ? { authTag } : {}),
    relayUrl,
    secretKey,
  });
  try {
    await relay.connect();
    const data = await executeCommand(parsed.resource, parsed.action, input, {
      allowInsecureLocalhost,
      ...(authTag ? { authTag } : {}),
      relay,
      relayUrl,
      secretKey,
    });
    await writeResult(normalizeWriteResult(data), parsed.format, parsed, input);
  } finally {
    relay.close();
    secretKey.fill(0);
  }
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  let format: "json" | "compact" = "json";
  let help = false;
  let input: string | undefined;
  let privateKey: string | undefined;
  let relay: string | undefined;
  let authTag: string | undefined;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "-V" || argument === "--version") {
      version = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    const matched = /^(--?[A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/.exec(argument);
    if (!matched) throw new TypeError(`invalid option: ${argument}`);
    const rawName = (matched[1] as string).replace(/^-+/, "");
    const name = camelCase(rawName);
    let rawValue = matched[2];
    const boolean = BOOLEAN_FLAGS.has(name);
    if (rawValue === undefined && !boolean) {
      const next = argv[index + 1];
      if (
        next === undefined ||
        (next.startsWith("-") && next !== "-" && !/^-\d+$/.test(next))
      ) {
        throw new TypeError(`--${rawName} requires a value`);
      }
      rawValue = next;
      index += 1;
    }
    const value: unknown = boolean
      ? rawValue === undefined
        ? true
        : parseBoolean(rawValue)
      : scalarValue(rawValue as string);
    if (name === "relay" || name === "r") {
      relay = String(value);
    } else if (name === "authTag") {
      authTag = String(value);
    } else if (name === "privateKey") {
      privateKey = String(value);
    } else if (name === "format") {
      if (value !== "json" && value !== "compact") {
        throw new TypeError("format must be json or compact");
      }
      format = value;
    } else if (name === "input" || name === "i") {
      input = String(value);
    } else if (name === "o") {
      assignFlag(flags, "output", value, false);
    } else {
      const repeatedName = REPEATED_FLAGS.get(name);
      assignFlag(
        flags,
        repeatedName ?? name,
        value,
        repeatedName !== undefined,
      );
    }
  }

  const [resource, firstAction, ...rest] = positionals;
  let action = firstAction?.replaceAll("_", "-");
  if (resource === "repos" && action === "protect" && rest[0]) {
    action = `protect-${rest.shift()}`;
  }
  applyPositionalInput(flags, resource, action, rest);
  return {
    ...(action ? { action } : {}),
    ...(authTag ? { authTag } : {}),
    flags,
    format,
    help,
    ...(input ? { input } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(relay ? { relay } : {}),
    ...(resource ? { resource } : {}),
    version,
  };
}

async function resolveInput(parsed: ParsedCli): Promise<unknown> {
  if (parsed.input !== undefined) return parseInput(parsed.input);
  const stdinKeys = [
    "content",
    "diff",
    "document",
    "patch",
    "systemPrompt",
    "yaml",
  ];
  const stdinKey = stdinKeys.find((key) => parsed.flags[key] === "-");
  if (stdinKey) {
    parsed.flags[stdinKey] = await readStdin();
    return hydrateFileInput(parsed, parsed.flags);
  }
  if (
    Object.keys(parsed.flags).length === 0 &&
    !process.stdin.isTTY &&
    parsed.resource !== "pack"
  ) {
    const value = (await readStdin()).trim();
    return value ? parseInput(value) : {};
  }
  return hydrateFileInput(parsed, parsed.flags);
}

async function hydrateFileInput(
  parsed: ParsedCli,
  flags: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fileField =
    parsed.resource === "patches" && parsed.action === "send"
      ? "patchFile"
      : parsed.resource === "mem" && parsed.action === "patch"
        ? "patchFile"
        : parsed.resource === "pr" &&
            ["open", "update", "status"].includes(parsed.action ?? "")
          ? "bodyFile"
          : parsed.resource === "emoji" && parsed.action === "import"
            ? "file"
            : undefined;
  if (!fileField || typeof flags[fileField] !== "string") return flags;
  const path = flags[fileField] as string;
  const raw = path === "-" ? await readStdin() : await readBoundedFile(path);
  if (parsed.resource === "emoji") {
    const manifest = parseInput(raw);
    return { ...flags, ...objectInput(manifest) };
  }
  const target = fileField === "bodyFile" ? "body" : "patch";
  return { ...flags, [target]: raw };
}

async function readBoundedFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new TypeError("command file input exceeds 1 MiB");
  }
  return bytes.toString("utf8");
}

function applyPositionalInput(
  flags: Record<string, unknown>,
  resource: string | undefined,
  action: string | undefined,
  rest: string[],
): void {
  if (!resource || !action) return;
  const positionalKey: Record<string, string> = {
    "agents:archive": "targetPubkey",
    "agents:unarchive": "targetPubkey",
    "issues:get": "event",
    "mem:get": "slug",
    "mem:hash": "slug",
    "mem:rm": "slug",
    "notes:get": "slug",
    "notes:rm": "slug",
    "pack:inspect": "path",
    "pack:validate": "path",
    "patches:get": "event",
    "pr:get": "event",
    "repos:get": "identifier",
    "social:get-event": "eventId",
  };
  const key = positionalKey[`${resource}:${action}`];
  if (key && rest[0] !== undefined) flags[key] = rest.shift();
  if (resource === "media" && action === "get" && rest[0] !== undefined) {
    flags.input = rest.shift();
  }
  if (
    resource === "mem" &&
    ["get", "hash", "set", "patch", "rm"].includes(action) &&
    rest[0] !== undefined
  ) {
    flags.slug = rest.shift();
  }
  if (resource === "mem" && action === "set" && rest[0] !== undefined) {
    flags.value = rest.shift();
  }
  if (rest.length > 0) {
    throw new TypeError(`unexpected positional arguments: ${rest.join(" ")}`);
  }
}

function assignFlag(
  flags: Record<string, unknown>,
  name: string,
  value: unknown,
  repeated: boolean,
): void {
  const current = flags[name];
  if (current === undefined) {
    flags[name] = repeated ? [value] : value;
  } else if (Array.isArray(current)) {
    current.push(value);
  } else {
    flags[name] = [current, value];
  }
}

function scalarValue(value: string): unknown {
  if (/^(?:0|[1-9]\d*)$/.test(value)) {
    const integer = Number(value);
    if (Number.isSafeInteger(integer)) return integer;
  }
  return value;
}

function parseBoolean(value: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new TypeError("boolean flag values must be true or false");
}

function camelCase(value: string): string {
  return value.replace(/[-_]([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function decodeSecretKey(value: string | undefined): Uint8Array {
  if (!value) throw new AuthError("BUZZ_PRIVATE_KEY is required");
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(Buffer.from(value, "hex"));
  }
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return Uint8Array.from(decoded.data);
  } catch {
    // The stable auth error below deliberately excludes parser internals.
  }
  throw new AuthError("BUZZ_PRIVATE_KEY must be nsec or 64-character hex");
}

export function parseAndVerifyAuthTag(
  value: string | undefined,
  agentSecretKey: Uint8Array,
): readonly [string, string, string, string] | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AuthError("BUZZ_AUTH_TAG must be a JSON string array");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== "auth" ||
    typeof parsed[1] !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed[1]) ||
    typeof parsed[2] !== "string" ||
    typeof parsed[3] !== "string" ||
    !/^[0-9a-f]{128}$/.test(parsed[3])
  ) {
    throw new AuthError(
      'BUZZ_AUTH_TAG must be ["auth",lowercase-owner-pubkey,conditions,lowercase-signature]',
    );
  }
  const [label, ownerPubkey, conditions, signature] = parsed as [
    string,
    string,
    string,
    string,
  ];
  validateOwnerAuthConditions(conditions);
  const agentPubkey = Buffer.from(
    schnorr.getPublicKey(agentSecretKey),
  ).toString("hex");
  if (ownerPubkey === agentPubkey) {
    throw new AuthError("BUZZ_AUTH_TAG self-attestation is not permitted");
  }
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agentPubkey}:${conditions}`, "utf8")
    .digest();
  let verified = false;
  try {
    verified = schnorr.verify(
      Uint8Array.from(Buffer.from(signature, "hex")),
      Uint8Array.from(digest),
      Uint8Array.from(Buffer.from(ownerPubkey, "hex")),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new AuthError(
      `BUZZ_AUTH_TAG verification failed for pubkey ${agentPubkey}`,
    );
  }
  return [label, ownerPubkey, conditions, signature];
}

function validateOwnerAuthConditions(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 4_096) {
    throw new AuthError("BUZZ_AUTH_TAG conditions are too large");
  }
  if (!value) return;
  if (/\s/.test(value)) {
    throw new AuthError("BUZZ_AUTH_TAG conditions must not contain whitespace");
  }
  for (const clause of value.split("&")) {
    const match = /^(kind=|created_at<|created_at>)(0|[1-9]\d*)$/.exec(clause);
    if (!match) {
      throw new AuthError(`BUZZ_AUTH_TAG condition is invalid: ${clause}`);
    }
    const number = Number(match[2]);
    const maximum = match[1] === "kind=" ? 65_535 : 4_294_967_295;
    if (!Number.isSafeInteger(number) || number > maximum) {
      throw new AuthError(`BUZZ_AUTH_TAG condition is out of range: ${clause}`);
    }
  }
}

function websocketRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("relay URL is invalid");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("relay URL must use http, https, ws, or wss");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      throw new TypeError("command input exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(value: string): unknown {
  if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) {
    throw new TypeError("command input exceeds 1 MiB");
  }
  return JSON.parse(value) as unknown;
}

function isLoopbackRelay(value: string): boolean {
  const hostname = new URL(value).hostname;
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function normalizeWriteResult(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("event" in value)
  ) {
    return value;
  }
  const result = value as {
    readonly [key: string]: unknown;
    readonly event?: unknown;
    readonly message?: unknown;
  };
  const event =
    typeof result.event === "object" && result.event !== null
      ? (result.event as { readonly id?: unknown })
      : undefined;
  const { event: _event, ...rest } = result;
  return {
    ...rest,
    accepted: true,
    event_id: typeof event?.id === "string" ? event.id : "",
    message: typeof result.message === "string" ? result.message : "",
  };
}

async function writeResult(
  value: unknown,
  format: "json" | "compact",
  parsed?: ParsedCli,
  input?: unknown,
): Promise<void> {
  if (value instanceof Uint8Array) {
    process.stdout.write(value);
    return;
  }
  const commandInput =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (
    parsed?.resource === "emoji" &&
    parsed.action === "export" &&
    typeof commandInput.file === "string"
  ) {
    await writeFile(commandInput.file, JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    if (parsed?.resource === "mem" && parsed.action === "get") {
      process.stdout.write(value);
      return;
    }
    if (
      (parsed?.resource === "mem" && parsed.action === "hash") ||
      (parsed?.resource === "notes" &&
        parsed.action === "get" &&
        commandInput.contentOnly === true) ||
      (parsed?.resource === "canvas" && parsed.action === "get")
    ) {
      process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
      return;
    }
  }
  const output =
    format === "compact" && Array.isArray(value)
      ? value.map(compactEvent)
      : value;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function compactEvent(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const input = value as Record<string, unknown>;
  return {
    content: input.content ?? "",
    created_at: input.created_at ?? 0,
    id: input.id ?? "",
  };
}

function helpText(): string {
  return [
    "Buzz CLI — interact with a Buzz relay",
    "",
    "Usage: buzz [--relay URL] [--private-key KEY] [--format json|compact]",
    "            <resource> <action> [options]",
    "       printf '%s' '<json>' | buzz <resource> <action>",
    "",
    "Resources:",
    "  agents       draft-create | draft-update | archive | unarchive | archived",
    "  messages     send | send-diff | edit | delete | get | thread | search | vote",
    "  channels     list | get | search | create | update | topic | purpose |",
    "               join | leave | archive | unarchive | delete | members |",
    "               add-member | remove-member | set-add-policy",
    "  canvas       get | set",
    "  reactions    add | remove | get",
    "  emoji        list | set | rm | export | import",
    "  dms          list | open | add-member | hide",
    "  users        get | set-profile | presence | set-presence",
    "  workflows    list | get | create | update | delete | trigger | runs | approve",
    "  feed         get",
    "  social       publish-note | set-contact-list | get-event | get-user-notes |",
    "               get-contact-list | set-list | get-list",
    "  notes        set | get | ls | rm",
    "  repos        create | get | list | protect list|set|remove",
    "  patches      send | get | list | status",
    "  issues       create | get | list | status",
    "  pr           open | update | get | list | status",
    "  media        get",
    "  upload       file",
    "  mem          ls | get | hash | set | patch | rm",
    "  moderation   reports | resolve | ban | unban | timeout | untimeout | audit",
    "  remote       invite | revoke",
    "  pack         validate | inspect (local; no relay key required)",
    "  events       publish | query | count (typed JSON escape hatch)",
    "",
    "Configuration:",
    "  BUZZ_RELAY_URL    Relay URL (default http://localhost:3000)",
    "  BUZZ_PRIVATE_KEY  Nostr nsec or 64-character hex key",
    "  BUZZ_AUTH_TAG     Optional NIP-OA tag JSON",
    "",
    "Exit codes: 0=ok  1=bad input/not found  2=relay/network  3=auth  4=other  5=conflict",
    "",
  ].join("\n");
}

function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("command input must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new TypeError("path is required");
  }
  return value;
}

class AuthError extends Error {}

function reportFailure(error: unknown): void {
  const message =
    error instanceof Error
      ? error.message.slice(0, 1_024).replaceAll(/[\r\n\t]/g, " ")
      : "command failed";
  const conflict =
    /(?:^conflict:|base hash mismatch|superseded by a newer head)/i.test(
      message,
    );
  const auth =
    error instanceof AuthError ||
    /(?:auth(?:entication)? (?:error|failed|required|rejected)|unauthorized|forbidden|HTTP 40[13])/i.test(
      message,
    );
  const input = error instanceof TypeError || error instanceof SyntaxError;
  const missing = /(?:not found|tombstoned)/i.test(message);
  const network =
    !conflict &&
    !auth &&
    !input &&
    /connect|network|relay|socket|timed out|disconnected/i.test(message);
  process.stderr.write(
    `${JSON.stringify({
      error: conflict
        ? "conflict"
        : auth
          ? "auth_error"
          : missing
            ? "not_found"
            : input
              ? "user_error"
              : network
                ? "network_error"
                : "error",
      message,
      retryable: false,
    })}\n`,
  );
  process.exitCode = conflict
    ? 5
    : auth
      ? 3
      : input || missing
        ? 1
        : network
          ? 2
          : 4;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(reportFailure);
}

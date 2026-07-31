import { KIND_HTTP_AUTH, signNostrEvent, unixNow } from "@buzz/core";
import {
  remoteCapabilitySchema,
  validateRemoteRelayUrl,
  type RemoteCapability,
} from "@buzz/remote-agent-protocol";

export type EnrollmentInvitation = {
  readonly enrollmentId: string;
  readonly expiresAt: number;
  readonly token: string;
};

export async function createEnrollmentInvitation(input: {
  readonly relayUrl: string;
  readonly ownerSecretKey: Uint8Array;
  readonly capabilities?: readonly RemoteCapability[];
  readonly lifetimeSeconds?: number;
  readonly allowInsecureLocalhost?: boolean;
  readonly fetchImplementation?: typeof fetch;
}): Promise<EnrollmentInvitation> {
  const relayUrl = validateRemoteRelayUrl(
    input.relayUrl,
    input.allowInsecureLocalhost,
  );
  const endpoint = relayHttpUrl(relayUrl, "/api/remote-agents/enrollments");
  const body = JSON.stringify({
    ...(input.capabilities
      ? {
          capabilities: input.capabilities.map((value) =>
            remoteCapabilitySchema.parse(value),
          ),
        }
      : {}),
    ...(input.lifetimeSeconds !== undefined
      ? { lifetimeSeconds: input.lifetimeSeconds }
      : {}),
  });
  const response = await (input.fetchImplementation ?? fetch)(endpoint, {
    body,
    cache: "no-store",
    headers: {
      Authorization: await nip98Authorization({
        body: new TextEncoder().encode(body),
        method: "POST",
        ownerSecretKey: input.ownerSecretKey,
        url: endpoint,
      }),
      "Content-Type": "application/json",
    },
    method: "POST",
    redirect: "error",
  });
  const value = (await response.json()) as unknown;
  if (!response.ok) throw safeResponseError(value, response.status);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { enrollmentId?: unknown }).enrollmentId !== "string" ||
    typeof (value as { expiresAt?: unknown }).expiresAt !== "number" ||
    typeof (value as { token?: unknown }).token !== "string"
  ) {
    throw new Error("relay returned an invalid enrollment invitation");
  }
  return value as EnrollmentInvitation;
}

export async function revokeRemoteWorker(input: {
  readonly relayUrl: string;
  readonly ownerSecretKey: Uint8Array;
  readonly workerPubkey: string;
  readonly allowInsecureLocalhost?: boolean;
  readonly fetchImplementation?: typeof fetch;
}): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(input.workerPubkey)) {
    throw new TypeError("workerPubkey must be 32-byte lowercase hex");
  }
  const relayUrl = validateRemoteRelayUrl(
    input.relayUrl,
    input.allowInsecureLocalhost,
  );
  const endpoint = relayHttpUrl(
    relayUrl,
    `/api/remote-agents/${input.workerPubkey}`,
  );
  const response = await (input.fetchImplementation ?? fetch)(endpoint, {
    cache: "no-store",
    headers: {
      Authorization: await nip98Authorization({
        body: new Uint8Array(),
        method: "DELETE",
        ownerSecretKey: input.ownerSecretKey,
        url: endpoint,
      }),
    },
    method: "DELETE",
    redirect: "error",
  });
  if (response.status === 204) return;
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  throw safeResponseError(value, response.status);
}

export async function nip98Authorization(input: {
  readonly url: string;
  readonly method: string;
  readonly body: Uint8Array;
  readonly ownerSecretKey: Uint8Array;
  readonly ownerAuthTag?: readonly [string, string, string, string];
  readonly now?: number;
}): Promise<string> {
  const tags = [
    ["u", input.url],
    ["method", input.method.toUpperCase()],
  ];
  if (input.body.length > 0) {
    tags.push(["payload", await sha256Hex(input.body)]);
  }
  if (input.ownerAuthTag) {
    tags.push([...validateOwnerAuthTag(input.ownerAuthTag)]);
  }
  const event = signNostrEvent(
    {
      content: "",
      created_at: input.now ?? unixNow(),
      kind: KIND_HTTP_AUTH,
      tags,
    },
    input.ownerSecretKey,
  );
  return `Nostr ${base64Encode(new TextEncoder().encode(JSON.stringify(event)))}`;
}

function validateOwnerAuthTag(
  value: readonly [string, string, string, string],
): readonly [string, string, string, string] {
  if (
    value.length !== 4 ||
    value[0] !== "auth" ||
    !/^[0-9a-f]{64}$/.test(value[1]) ||
    new TextEncoder().encode(value[2]).byteLength > 1_024 ||
    !/^[0-9a-f]{128}$/.test(value[3])
  ) {
    throw new TypeError(
      "ownerAuthTag must be a structurally valid NIP-OA auth tag",
    );
  }
  return [...value] as [string, string, string, string];
}

function relayHttpUrl(relayUrl: URL, path: string): string {
  const endpoint = new URL(path, relayUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  return endpoint.toString();
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copied = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function base64Encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeResponseError(value: unknown, status: number): Error {
  const code =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : "REQUEST_FAILED";
  return new Error(`remote-agent request failed (${status}, ${code})`);
}

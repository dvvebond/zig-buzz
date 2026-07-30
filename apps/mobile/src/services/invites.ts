import { KIND_HTTP_AUTH, signNostrEvent } from "@buzz/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateSecretKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

import { useAppStore } from "../state/app-store";
import { normalizeRelayInput } from "./community-storage";
import { relayHttpOrigin } from "./mobile-relay";

export async function claimInvite(input: {
  readonly relayUrl: string;
  readonly code: string;
  readonly policyReceipt?: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(input.code)) {
    throw new TypeError("invite code is invalid");
  }
  const relayUrl = normalizeRelayInput(input.relayUrl);
  const url = `${relayHttpOrigin(relayUrl)}/api/invites/claim`;
  const secretKey = generateSecretKey();
  try {
    const nsec = nip19.nsecEncode(secretKey);
    const body = new TextEncoder().encode(
      JSON.stringify({
        code: input.code,
        ...(input.policyReceipt ? { policy_receipt: input.policyReceipt } : {}),
      }),
    );
    const auth = nip98Authorization("POST", url, body, secretKey);
    const response = await fetch(url, {
      body,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "manual",
    });
    const raw = await readBounded(response, 64 * 1024);
    let payload: unknown;
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const code =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
      throw new InviteError(code);
    }
    const name =
      isRecord(payload) &&
      typeof payload.host === "string" &&
      payload.host.trim()
        ? payload.host.trim().slice(0, 128)
        : undefined;
    await useAppStore.getState().authenticate({
      nsec,
      relayUrl,
      ...(name === undefined ? {} : { name }),
    });
  } finally {
    secretKey.fill(0);
  }
}

export class InviteError extends Error {
  public constructor(readonly code: string) {
    super(friendlyInviteError(code));
    this.name = "InviteError";
  }
}

function nip98Authorization(
  method: string,
  url: string,
  body: Uint8Array,
  secretKey: Uint8Array,
): string {
  const event = signNostrEvent(
    {
      content: "",
      created_at: Math.floor(Date.now() / 1_000),
      kind: KIND_HTTP_AUTH,
      tags: [
        ["u", url],
        ["method", method],
        ["payload", bytesToHex(sha256(body))],
      ],
    },
    secretKey,
  );
  return `Nostr ${base64(new TextEncoder().encode(JSON.stringify(event)))}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maximum) {
    throw new Error("invite response is too large");
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > maximum) {
    throw new Error("invite response is too large");
  }
  return raw;
}

function friendlyInviteError(code: string): string {
  if (code.includes("invite_expired")) return "This invite has expired.";
  if (code.includes("invite_exhausted")) {
    return "This invite reached its use limit. Ask for a new invite.";
  }
  if (code.includes("invite_invalid")) return "This invite is not valid.";
  if (code.includes("join_policy_required")) {
    return "The join-policy receipt expired. Re-open the invite link.";
  }
  return `Could not join this community: ${code.slice(0, 160)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

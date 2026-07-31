const HEX_64 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_CODE = /^[A-Za-z0-9_-]{8,256}$/;

export type BuzzDeepLink =
  | {
      readonly type: "message";
      readonly channelId: string;
      readonly messageId: string;
      readonly threadRootId?: string;
    }
  | {
      readonly type: "invite";
      readonly relayUrl: string;
      readonly code: string;
      readonly policyReceipt?: string;
    }
  | {
      readonly type: "pairing";
      readonly uri: string;
    };

export function parseDeepLink(value: string): BuzzDeepLink | undefined {
  if (value.length < 1 || value.length > 2_048) return undefined;
  if (value.startsWith("nostrpair://")) {
    return { type: "pairing", uri: value };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.hash) return undefined;

  if (url.protocol === "buzz:" && url.hostname === "message") {
    const channelId = url.searchParams.get("channel") ?? "";
    const messageId = url.searchParams.get("id") ?? "";
    const threadRootId = url.searchParams.get("thread") ?? undefined;
    if (
      !UUID.test(channelId) ||
      !HEX_64.test(messageId) ||
      (threadRootId !== undefined && !HEX_64.test(threadRootId))
    ) {
      return undefined;
    }
    return {
      channelId: channelId.toLowerCase(),
      messageId,
      type: "message",
      ...(threadRootId === undefined ? {} : { threadRootId }),
    };
  }

  if (url.protocol === "buzz:" && url.hostname === "join") {
    const relayUrl = url.searchParams.get("relay");
    const code = url.searchParams.get("code");
    const policyReceipt = url.searchParams.get("policy_receipt") ?? undefined;
    if (!relayUrl || !code || !INVITE_CODE.test(code)) return undefined;
    const normalized = validateRelayUrl(relayUrl, false);
    if (!normalized) return undefined;
    return {
      code,
      relayUrl: normalized,
      type: "invite",
      ...(policyReceipt === undefined ? {} : { policyReceipt }),
    };
  }

  if (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.pathname.startsWith("/invite/")
  ) {
    const path = url.pathname.split("/").filter(Boolean);
    const code = path.length === 2 ? path[1] : undefined;
    if (!code || !INVITE_CODE.test(code) || url.search) return undefined;
    const websocket = new URL(url.origin);
    websocket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const relayUrl = validateRelayUrl(websocket.toString(), false);
    return relayUrl ? { code, relayUrl, type: "invite" } : undefined;
  }

  return undefined;
}

export function buildMessageLink(input: {
  readonly channelId: string;
  readonly messageId: string;
  readonly threadRootId?: string;
}): string {
  if (
    !UUID.test(input.channelId) ||
    !HEX_64.test(input.messageId) ||
    (input.threadRootId !== undefined && !HEX_64.test(input.threadRootId))
  ) {
    throw new TypeError("message link fields are invalid");
  }
  const url = new URL("buzz://message");
  url.searchParams.set("channel", input.channelId.toLowerCase());
  url.searchParams.set("id", input.messageId);
  if (input.threadRootId) {
    url.searchParams.set("thread", input.threadRootId);
  }
  return url.toString();
}

export function validateRelayUrl(
  value: string,
  allowInsecureLoopback: boolean,
): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "wss:" && url.protocol !== "ws:")
  ) {
    return undefined;
  }
  const loopback = isLoopback(url.hostname);
  if (url.protocol === "ws:" && !(allowInsecureLoopback && loopback)) {
    return undefined;
  }
  if (!loopback && isPrivateIpv4(url.hostname)) return undefined;
  url.pathname = "/";
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

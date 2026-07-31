import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;

export type WebhookResult = {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
};

export async function callWorkflowWebhook(input: {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMilliseconds?: number;
}): Promise<WebhookResult> {
  const url = validateWebhookUrl(input.url);
  const method = (input.method ?? "POST").toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) {
    throw new WorkflowWebhookError("webhook method is not allowed");
  }
  const body = Buffer.from(input.body ?? "", "utf8");
  if (body.length > MAX_REQUEST_BYTES) {
    throw new WorkflowWebhookError("webhook request body exceeds 256 KiB");
  }
  const timeout = input.timeoutMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
    throw new WorkflowWebhookError(
      "webhook timeout must be between 1 and 60 seconds",
    );
  }
  const address = await resolvePublicAddress(url.hostname);
  const family = isIP(address) as 4 | 6;
  return new Promise<WebhookResult>((resolve, reject) => {
    const requestHeaders: Record<string, string | number> = {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
      "Content-Length": body.length,
      "Content-Type": "application/json",
      "User-Agent": "Buzz-Workflow/0.1",
      ...input.headers,
      Host: url.host,
    };
    const outgoing = request(
      {
        family,
        headers: requestHeaders,
        hostname: url.hostname,
        lookup: (_hostname, _options, callback) => {
          callback(null, address, family);
        },
        method,
        path: `${url.pathname}${url.search}`,
        port: url.port ? Number(url.port) : 443,
        protocol: "https:",
        servername: url.hostname,
        signal: AbortSignal.timeout(timeout),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (raw: Buffer | string) => {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(
              new WorkflowWebhookError(
                "webhook response exceeds the 1 MiB limit",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const contentType = response.headers["content-type"];
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            ...(typeof contentType === "string" ? { contentType } : {}),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    outgoing.once("error", (error) => {
      reject(
        error instanceof WorkflowWebhookError
          ? error
          : new WorkflowWebhookError("webhook request failed"),
      );
    });
    outgoing.end(body);
  });
}

export function validateWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkflowWebhookError("webhook URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    (url.port && Number(url.port) !== 443)
  ) {
    throw new WorkflowWebhookError(
      "webhook URL must be public HTTPS on port 443 without credentials or fragments",
    );
  }
  return url;
}

export async function resolvePublicAddress(hostname: string): Promise<string> {
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicAddress(hostname)) {
      throw new WorkflowWebhookError(
        "webhook destination resolves to a private or reserved address",
      );
    }
    return hostname;
  }
  let addresses: readonly {
    readonly address: string;
    readonly family: number;
  }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new WorkflowWebhookError("webhook DNS resolution failed");
  }
  if (addresses.length === 0) {
    throw new WorkflowWebhookError("webhook DNS returned no addresses");
  }
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WorkflowWebhookError(
      "webhook destination resolves to a private or reserved address",
    );
  }
  return addresses[0]?.address as string;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isPublicIpv4(mapped[1]);
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return false;
  }
  return true;
}

function isPublicIpv4(address: string): boolean {
  const bytes = address.split(".").map(Number);
  if (
    bytes.length !== 4 ||
    bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    return false;
  }
  const [a, b, c] = bytes as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export class WorkflowWebhookError extends Error {
  public override readonly name = "WorkflowWebhookError";
}

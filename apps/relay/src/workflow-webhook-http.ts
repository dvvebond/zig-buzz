import type { IncomingMessage, ServerResponse } from "node:http";

import {
  WorkflowStoreAuthorizationError,
  WorkflowWebhookAuthenticationError,
  type WorkflowRuntime,
} from "@buzz/workflow";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_SECRET_BYTES = 1_024;

export async function handleWorkflowWebhookHttp(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly community: string;
    readonly runtime?: WorkflowRuntime;
    readonly publicUrl: URL;
  },
): Promise<boolean> {
  if (request.method !== "POST") return false;
  const url = new URL(request.url ?? "/", httpBaseUrl(input.publicUrl));
  const match = /^\/hooks\/([^/]+)$/.exec(url.pathname);
  if (!match?.[1]) return false;
  if (!input.runtime || !UUID.test(match[1])) {
    json(response, 404, { error: "workflow not found" });
    return true;
  }
  try {
    const body = await readBody(request);
    const headerSecret = request.headers["x-webhook-secret"];
    const secret =
      (Array.isArray(headerSecret) ? headerSecret[0] : headerSecret) ??
      url.searchParams.get("secret") ??
      "";
    if (
      typeof secret !== "string" ||
      Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES
    ) {
      throw new WorkflowWebhookAuthenticationError(
        "workflow webhook authentication failed",
      );
    }
    const fields = parseWebhookFields(body);
    const runId = await input.runtime.triggerWebhook({
      community: input.community,
      fields,
      secret,
      workflowId: match[1].toLowerCase(),
    });
    response.setHeader("Cache-Control", "no-store");
    json(response, 202, {
      run_id: runId,
      status: "pending",
      workflow_id: match[1].toLowerCase(),
    });
  } catch (error) {
    response.setHeader("Cache-Control", "no-store");
    if (error instanceof WorkflowWebhookAuthenticationError) {
      json(response, 401, { error: "authentication failed" });
    } else if (error instanceof WorkflowStoreAuthorizationError) {
      json(response, 404, { error: "workflow not found" });
    } else if (error instanceof WebhookBodyError) {
      json(response, error.status, { error: error.message });
    } else {
      json(response, 500, { error: "internal_error" });
    }
  }
  return true;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new WebhookBodyError(413, "request_body_too_large");
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (body.length > 0) {
    const contentType = request.headers["content-type"]
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new WebhookBodyError(415, "content_type_must_be_application_json");
    }
  }
  return body;
}

function parseWebhookFields(body: Buffer): Readonly<Record<string, string>> {
  if (body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new WebhookBodyError(400, "invalid_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > 100) {
    throw new WebhookBodyError(400, "too_many_webhook_fields");
  }
  const output: Record<string, string> = Object.create(null);
  for (const [key, field] of entries) {
    if (key.length === 0 || Buffer.byteLength(key, "utf8") > 256) {
      throw new WebhookBodyError(400, "invalid_webhook_field");
    }
    const encoded = typeof field === "string" ? field : JSON.stringify(field);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded, "utf8") > 64 * 1024
    ) {
      throw new WebhookBodyError(400, "invalid_webhook_field");
    }
    output[key] = encoded;
  }
  return output;
}

class WebhookBodyError extends Error {
  public constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WebhookBodyError";
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function httpBaseUrl(publicUrl: URL): URL {
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

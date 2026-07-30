import type { IncomingMessage, ServerResponse } from "node:http";

import {
  fencedHeader,
  type AcquireResult,
  type MeshSessionStream,
  type Profile,
  type RuntimeId,
} from "@buzz/relay-mesh";
import { z } from "zod";

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_ECHO_TIMEOUT_MS = 10_000;

const requestSchema = z
  .object({
    community_id: z.uuid(),
    session_id: z.uuid(),
    payload: z.string(),
  })
  .strict();

export interface MeshDemoDirectory {
  acquire(
    communityId: string,
    sessionId: string,
    ownerRuntimeId: RuntimeId,
    profile: Profile,
  ): Promise<AcquireResult>;
}

export interface MeshDemoNode {
  readonly runtimeId: RuntimeId;
  openSessionStream(
    to: RuntimeId,
    fenced: ReturnType<typeof fencedHeader>,
    profile: "reliable_stream",
  ): MeshSessionStream;
}

export interface MeshDemoHttpOptions {
  readonly communityId: string;
  readonly directory: MeshDemoDirectory;
  readonly node: MeshDemoNode;
  readonly timeoutMs?: number;
}

/**
 * Testbed-only reliable-stream smoke endpoint.
 *
 * The class is only constructed when both BUZZ_MESH and
 * BUZZ_MESH_DEMO_ECHO are enabled, so an ordinary deployment has no route.
 */
export class MeshDemoHttp {
  readonly #options: MeshDemoHttpOptions;

  public constructor(options: MeshDemoHttpOptions) {
    if (!z.uuid().safeParse(options.communityId).success) {
      throw new Error("mesh demo requires a UUID community identity");
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    ) {
      throw new Error("mesh demo timeout must be a positive safe integer");
    }
    this.#options = options;
  }

  public async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const url = parseRequestUrl(request.url);
    if (url?.pathname !== "/_mesh/demo/echo") return false;
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      json(response, 405, { error: "method not allowed" });
      return true;
    }

    try {
      requireJson(request);
      const body = requestSchema.parse(
        JSON.parse(
          (await readBoundedBody(request)).toString("utf8"),
        ) as unknown,
      );
      if (body.community_id !== this.#options.communityId) {
        throw new MeshDemoError(404, "community not found");
      }
      if (Buffer.byteLength(body.payload, "utf8") > MAX_REQUEST_BYTES) {
        throw new MeshDemoError(413, "payload too large");
      }

      const acquired = await this.#options.directory.acquire(
        body.community_id,
        body.session_id,
        this.#options.node.runtimeId,
        "reliable_stream",
      );
      const { lease } = acquired;
      if (lease.profile !== "reliable_stream") {
        throw new MeshDemoError(502, "join failed: profile mismatch");
      }
      if (
        acquired.status === "acquired" ||
        lease.ownerRuntimeId === this.#options.node.runtimeId
      ) {
        json(response, 200, {
          outcome: "owned",
          generation: lease.generation,
          owner_runtime_id: lease.ownerRuntimeId,
        });
        return true;
      }

      const stream = this.#options.node.openSessionStream(
        lease.ownerRuntimeId,
        fencedHeader(lease),
        "reliable_stream",
      );
      const iterator = stream[Symbol.asyncIterator]();
      try {
        stream.send(Buffer.from(body.payload, "utf8"));
        const echoed = await withTimeout(
          iterator.next(),
          this.#options.timeoutMs ?? DEFAULT_ECHO_TIMEOUT_MS,
        );
        if (echoed.done) {
          throw new MeshDemoError(502, "stream closed before echo");
        }
        json(response, 200, {
          outcome: "forwarded",
          generation: lease.generation,
          owner_runtime_id: lease.ownerRuntimeId,
          echoed_payload: Buffer.from(echoed.value).toString("utf8"),
        });
      } finally {
        stream.close();
        await iterator.return?.();
      }
      return true;
    } catch (error) {
      const mapped = mapError(error);
      json(response, mapped.status, { error: mapped.message });
      return true;
    }
  }
}

class MeshDemoError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MeshDemoError";
  }
}

function parseRequestUrl(value: string | undefined): URL | undefined {
  try {
    return new URL(value ?? "", "http://relay.invalid");
  } catch {
    return undefined;
  }
}

function requireJson(request: IncomingMessage): void {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
  ) {
    throw new MeshDemoError(415, "content-type must be application/json");
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new MeshDemoError(413, "request body too large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new MeshDemoError(413, "request body too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MeshDemoError(504, "timed out waiting for echo")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapError(error: unknown): MeshDemoError {
  if (error instanceof MeshDemoError) return error;
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return new MeshDemoError(400, "invalid request");
  }
  const detail =
    error instanceof Error
      ? error.message.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160)
      : "unknown error";
  return new MeshDemoError(502, `mesh join failed: ${detail}`);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

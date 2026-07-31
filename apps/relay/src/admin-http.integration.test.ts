import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blobKey, FileMediaStorage, putSidecar } from "@buzz/media";
import type { Pool, QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayAdminHttp } from "./admin-http.js";

const ADMIN_HOST = "admin.example";
const COMMUNITY_ID = "4e7e382c-73eb-47bc-9c71-7d84b93da313";
const FEEDBACK_ID = "d945196e-9e7f-4d45-8a0a-1f6fef37110f";
const REPORT_ID = "2817df62-42e0-4608-9f19-6f7f9867da63";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("deployment admin HTTP", () => {
  it("rejects the wrong Host and cross-origin browser requests before database access", async () => {
    const query = vi.fn(async () => rows([]));
    const handler = new RelayAdminHttp({
      host: ADMIN_HOST,
      pool: { query } as unknown as Pool,
    });
    const server = await start(handler);
    try {
      const wrongHost = await adminFetch(
        server.origin,
        "/api/admin/v1/reports",
      );
      expect(wrongHost.status).toBe(403);
      const wrongOrigin = await adminFetch(
        server.origin,
        "/api/admin/v1/reports",
        {
          headers: {
            Host: ADMIN_HOST,
            Origin: "https://attacker.example",
          },
        },
      );
      expect(wrongOrigin.status).toBe(403);
      expect(query).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns bounded global report rows as the dashboard camel-case contract", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) =>
      rows([
        {
          action_id: null,
          channel_id: null,
          community_host: "team.example",
          community_id: COMMUNITY_ID,
          created_at: new Date("2026-07-28T10:00:00Z"),
          id: REPORT_ID,
          note: "private context",
          report_event_id: "a".repeat(64),
          report_type: "spam",
          reporter_pubkey: "b".repeat(64),
          resolved_at: null,
          resolved_by: null,
          status: "open",
          target: "c".repeat(64),
          target_kind: "event",
        },
      ]),
    );
    const handler = new RelayAdminHttp({
      host: ADMIN_HOST,
      pool: { query } as unknown as Pool,
    });
    const server = await start(handler);
    try {
      const response = await adminFetch(
        server.origin,
        "/api/admin/v1/reports?status=open&targetKind=event&limit=25",
        {
          headers: {
            Host: ADMIN_HOST,
            Origin: `https://${ADMIN_HOST}`,
          },
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual([
        {
          actionId: null,
          channelId: null,
          communityHost: "team.example",
          communityId: COMMUNITY_ID,
          createdAt: "2026-07-28T10:00:00.000Z",
          id: REPORT_ID,
          note: "private context",
          reportEventId: "a".repeat(64),
          reportType: "spam",
          reporterPubkey: "b".repeat(64),
          resolvedAt: null,
          resolvedBy: null,
          status: "open",
          target: "c".repeat(64),
          targetKind: "event",
        },
      ]);
      expect(query.mock.calls[0]?.[1]).toEqual([
        null,
        "open",
        null,
        "event",
        null,
        null,
        25,
      ]);
    } finally {
      await server.close();
    }
  });

  it("serves only feedback-referenced bytes under their source-community sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-admin-media-"));
    directories.push(root);
    const storage = new FileMediaStorage(root);
    const bytes = Buffer.from("private diagnostic");
    const sha256 =
      "7ee0071591b7a2830783d31446275f1678ae12051c1331fbb45d11290d7d0b7b";
    await storage.put(blobKey(sha256, "txt"), bytes, "text/plain");
    await putSidecar(storage, COMMUNITY_ID, sha256, {
      blurhash: "",
      dim: "",
      ext: "txt",
      mimeType: "text/plain",
      size: bytes.length,
      thumbUrl: "",
      uploadedAt: 1,
    });
    const feedback = {
      body: `Logs\n[attachment](https://team.example/media/${sha256}.txt)`,
      category: "bug",
      community_host: "team.example",
      community_id: COMMUNITY_ID,
      event_created_at: new Date("2026-07-28T10:00:00Z"),
      event_id: "d".repeat(64),
      id: FEEDBACK_ID,
      received_at: new Date("2026-07-28T10:01:00Z"),
      submitter_pubkey: "e".repeat(64),
      tags: [
        [
          "imeta",
          `url https://team.example/media/${sha256}.txt`,
          `x ${sha256}`,
          "m text/plain",
        ],
      ],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM product_feedback")) return rows([feedback]);
      if (sql.includes("FROM communities")) {
        return rows([{ id: COMMUNITY_ID }]);
      }
      return rows([]);
    });
    const handler = new RelayAdminHttp({
      host: ADMIN_HOST,
      mediaStorage: storage,
      pool: { query } as unknown as Pool,
    });
    const server = await start(handler);
    try {
      const path = `/api/admin/v1/feedback/${FEEDBACK_ID}/attachments/${sha256}`;
      const response = await adminFetch(server.origin, path, {
        headers: { Host: ADMIN_HOST },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

      const substituted = await adminFetch(
        server.origin,
        `/api/admin/v1/feedback/${FEEDBACK_ID}/attachments/${"f".repeat(64)}`,
        { headers: { Host: ADMIN_HOST } },
      );
      expect(substituted.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

async function start(handler: RelayAdminHttp): Promise<{
  readonly close: () => Promise<void>;
  readonly origin: string;
}> {
  const server = createServer((request, response) => {
    void handler.handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("admin test server did not bind");
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    origin: `http://127.0.0.1:${address.port}`,
  };
}

function rows<T extends Record<string, unknown>>(values: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: values.length,
    rows: values,
  };
}

async function adminFetch(
  origin: string,
  pathname: string,
  init: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: string;
  } = {},
): Promise<Response> {
  const url = new URL(pathname, origin);
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        headers: init.headers,
        hostname: url.hostname,
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        port: url.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              headers,
              status: response.statusCode ?? 500,
            }),
          );
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

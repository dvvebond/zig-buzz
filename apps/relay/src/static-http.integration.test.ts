import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRelayServer } from "./server.js";
import { RelayStaticHttp } from "./static-http.js";

const directories: string[] = [];
const relays: Array<ReturnType<typeof createRelayServer>> = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("relay static SPA fallback", () => {
  it("serves only explicit public routes and safe asset paths", async () => {
    const directory = await fixtureDirectory("public");
    const handler = new RelayStaticHttp({
      public: {
        serveGitWebGui: false,
        webDirectory: directory,
      },
    });
    const server = await start(handler, "public");
    try {
      const invite = await fetch(`${server.origin}/invite/v2.code`);
      expect(invite.status).toBe(200);
      expect(await invite.text()).toContain("public");
      expect(invite.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );

      const asset = await fetch(`${server.origin}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toBe("export const ready = true;");

      expect((await fetch(`${server.origin}/repos/demo`)).status).toBe(404);
      expect((await fetch(`${server.origin}/api/invites`)).status).toBe(404);
      expect(
        (await fetch(`${server.origin}/assets/%2e%2e/index.html`)).status,
      ).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("isolates the admin SPA by exact host and explicit admin paths", async () => {
    const directory = await fixtureDirectory("admin");
    const handler = new RelayStaticHttp({
      admin: {
        host: "admin.example",
        webDirectory: directory,
      },
    });
    const server = await start(handler, "admin");
    try {
      const accepted = await rawGet(
        server.origin,
        "/feedback/item",
        "admin.example",
      );
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toContain("admin");
      expect(
        (await rawGet(server.origin, "/feedback/item", "team.example")).status,
      ).toBe(404);
      expect(
        (await rawGet(server.origin, "/arbitrary", "admin.example")).status,
      ).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("keeps the explicit NIP-11 route ahead of the opt-in git SPA root", async () => {
    const directory = await fixtureDirectory("git");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl: new URL("ws://localhost:1/"),
      static: {
        public: {
          serveGitWebGui: true,
          webDirectory: directory,
        },
      },
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("static relay did not bind");
    }
    const base = `http://localhost:${address.port}`;
    const root = await fetch(`${base}/`);
    expect(root.headers.get("content-type")).toContain(
      "application/nostr+json",
    );
    const browserRoot = await fetch(`${base}/`, {
      headers: { Accept: "text/html" },
    });
    expect(browserRoot.headers.get("content-type")).toContain("text/html");
    expect(await browserRoot.text()).toContain("git");
    const repos = await fetch(`${base}/repos/example`);
    expect(repos.headers.get("content-type")).toContain("text/html");
    expect(await repos.text()).toContain("git");
  });
});

async function fixtureDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "buzz-static-"));
  directories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><p>${label}</p>`,
  );
  await writeFile(
    join(directory, "assets", "app.js"),
    "export const ready = true;",
  );
  return directory;
}

async function start(
  handler: RelayStaticHttp,
  surface: "admin" | "public",
): Promise<{ readonly close: () => Promise<void>; readonly origin: string }> {
  const server = createServer((request, response) => {
    const handled =
      surface === "admin"
        ? handler.handleAdmin(request, response)
        : handler.handlePublic(request, response);
    void handled.then((accepted) => {
      if (!accepted) response.writeHead(404).end();
    });
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
    throw new Error("static test server did not bind");
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function rawGet(
  origin: string,
  path: string,
  host: string,
): Promise<Response> {
  const url = new URL(path, origin);
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { Host: host },
        hostname: url.hostname,
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

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DevMcpServer } from "./index.js";

describe("DevMcpServer", () => {
  it("lists tools and performs numbered read plus atomic replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-dev-mcp-"));
    const file = join(root, "a.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n");
    const server = new DevMcpServer();
    const listed = (await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toContain("str_replace");
    const read = (await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "read_file",
        arguments: { path: "a.txt", workdir: root, offset: 1, limit: 1 },
      },
    })) as { content: { text: string }[] };
    expect(read.content[0]?.text).toContain("2:beta");
    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "str_replace",
        arguments: {
          path: "a.txt",
          workdir: root,
          old_str: "beta",
          new_str: "BETA",
        },
      },
    });
    expect(await readFile(file, "utf8")).toContain("BETA");
  });

  it("preserves open todo state across stop and compact hooks", async () => {
    const server = new DevMcpServer();
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "todo",
        arguments: { todos: [{ text: "finish port", done: false }] },
      },
    });
    const stopped = (await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "_Stop", arguments: {} },
    })) as { content: { text: string }[] };
    expect(stopped.content[0]?.text).toContain("Keep working");
  });
});

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseManifest,
  parsePersonaMarkdown,
  PersonaPackError,
  resolvePack,
  splitFrontmatter,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("persona parsing", () => {
  it("parses strict frontmatter and preserves the prompt body exactly", () => {
    const source = `---
name: reviewer
display_name: Security Reviewer
description: Reviews changes.
model: openai:gpt-5
subscribe: []
triggers:
  mentions: false
  keywords: [CVE]
---
You are a careful reviewer.
`;
    const persona = parsePersonaMarkdown(source);
    expect(persona).toMatchObject({
      description: "Reviews changes.",
      displayName: "Security Reviewer",
      model: "openai:gpt-5",
      name: "reviewer",
      prompt: "You are a careful reviewer.\n",
      subscribe: [],
      triggers: { keywords: ["CVE"], mentions: false },
    });
    expect(splitFrontmatter(source).body).toBe("You are a careful reviewer.\n");
  });

  it("rejects unknown fields, duplicate YAML keys, and malformed identities", () => {
    for (const source of [
      "---\nname: x\ndisplay_name: X\ndescription: X\n typo: true\n---\n",
      "---\nname: x\nname: y\ndisplay_name: X\ndescription: X\n---\n",
      "---\nname: ../x\ndisplay_name: X\ndescription: X\n---\n",
    ]) {
      expect(() => parsePersonaMarkdown(source)).toThrow(PersonaPackError);
    }
  });

  it("parses the permissive OPS manifest while requiring identity fields", () => {
    expect(
      parseManifest(
        JSON.stringify({
          id: "pack",
          name: "Pack",
          ops_category: "ignored extension",
          version: "1.0.0",
        }),
      ),
    ).toMatchObject({ id: "pack", personas: [] });
    expect(() => parseManifest('{"id":"pack"}')).toThrow(PersonaPackError);
  });
});

describe("persona pack resolution", () => {
  it("loads safely, applies precedence, merges MCP by name, and projects runtime env", async () => {
    const root = await packRoot();
    await writeFile(
      join(root, ".plugin/plugin.json"),
      JSON.stringify({
        defaults: {
          broadcast_replies: true,
          model: "anthropic:claude-default",
          subscribe: ["#general"],
          temperature: 0.5,
          triggers: { all_messages: true, keywords: ["default"] },
        },
        id: "test-pack",
        mcp_config: ".mcp.json",
        name: "Test Pack",
        personas: ["personas/reviewer.persona.md"],
        version: "2.0.0",
      }),
    );
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { command: "old", env: { TOKEN: "${TOKEN}" } },
          search: { command: "search" },
        },
      }),
    );
    await writeFile(join(root, "instructions.md"), " Pack rules. \n");
    await writeFile(
      join(root, "personas/reviewer.persona.md"),
      `---
name: reviewer
display_name: Reviewer
description: Reviews.
runtime: buzz-agent
model: openai:gpt-5
subscribe: []
triggers:
  mentions: false
  keywords: [CVE]
mcp_servers:
  - name: files
    command: new
    args: [--safe]
skills: [skills/private]
---
Review carefully.
`,
    );
    await mkdir(join(root, "skills/private"), { recursive: true });
    await mkdir(join(root, "skills/shared"), { recursive: true });
    const pack = await resolvePack(root);
    expect(pack.personas[0]).toMatchObject({
      broadcastReplies: true,
      llmProvider: "openai",
      mcpServers: [
        { command: "new", name: "files" },
        { command: "search", name: "search" },
      ],
      model: "gpt-5",
      packInstructions: "Pack rules.",
      runtimeEnvVars: {
        BUZZ_AGENT_MODEL: "gpt-5",
        BUZZ_AGENT_PROVIDER: "openai",
        GOOSE_TEMPERATURE: "0.5",
      },
      skills: ["private", "shared"],
      subscribe: [],
      triggers: { allMessages: false, keywords: ["CVE"], mentions: false },
    });
  });

  it("rejects manifest traversal and symlink escape", async () => {
    const root = await packRoot();
    await writeFile(
      join(root, ".plugin/plugin.json"),
      JSON.stringify({
        id: "bad",
        name: "Bad",
        personas: ["../escape.persona.md"],
        version: "1",
      }),
    );
    await expect(resolvePack(root)).rejects.toMatchObject({
      code: "PATH_TRAVERSAL",
    });
    const outside = await mkdtemp(join(tmpdir(), "buzz-persona-outside-"));
    directories.push(outside);
    await writeFile(
      join(outside, "escape.persona.md"),
      "---\nname: x\ndisplay_name: X\ndescription: X\n---\n",
    );
    await symlink(
      join(outside, "escape.persona.md"),
      join(root, "personas/escape.persona.md"),
    );
    await writeFile(
      join(root, ".plugin/plugin.json"),
      JSON.stringify({
        id: "bad",
        name: "Bad",
        personas: ["personas/escape.persona.md"],
        version: "1",
      }),
    );
    await expect(resolvePack(root)).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });
});

async function packRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "buzz-persona-"));
  directories.push(root);
  await mkdir(join(root, ".plugin"), { recursive: true });
  await mkdir(join(root, "personas"), { recursive: true });
  return root;
}

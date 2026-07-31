import {
  decryptObserverPayload,
  KIND_MANAGED_AGENT,
  signNostrEvent,
  unixNow,
} from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { executeCommand, type CommandContext } from "./commands.js";

function context(
  input: {
    readonly authTag?: readonly string[];
    readonly info?: CommandContext["relay"]["info"];
    readonly publishMessage?: string;
    readonly query?: CommandContext["relay"]["query"];
    readonly uploadFile?: CommandContext["relay"]["uploadFile"];
  } = {},
): CommandContext & {
  readonly published: unknown[];
} {
  const published: unknown[] = [];
  return {
    allowInsecureLocalhost: true,
    ...(input.authTag ? { authTag: input.authTag } : {}),
    published,
    relay: {
      count: vi.fn(async () => 3),
      ...(input.info ? { info: input.info } : {}),
      publish: vi.fn(async (event) => {
        published.push(event);
        return input.publishMessage ?? "";
      }),
      query: input.query ?? vi.fn(async () => []),
      ...(input.uploadFile ? { uploadFile: input.uploadFile } : {}),
    },
    relayUrl: "ws://localhost:3000/",
    secretKey: generateSecretKey(),
  };
}

describe("Buzz CLI commands", () => {
  it("builds, signs, and publishes a channel message", async () => {
    const ctx = context();
    const result = await executeCommand(
      "messages",
      "send",
      {
        channelId: "00000000-0000-4000-8000-000000000001",
        content: "hello",
      },
      ctx,
    );
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]).toMatchObject({ content: "hello", kind: 9 });
    expect(result).toMatchObject({ message: "" });
  });

  it("uploads message files and publishes complete NIP-92 imeta tags", async () => {
    const ctx = context({
      uploadFile: vi.fn(async () => ({
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        dim: "640x480",
        sha256: "a".repeat(64),
        size: 1234,
        type: "image/png",
        uploaded: 1,
        url: "https://relay.example/media/a.png",
      })),
    });
    await executeCommand(
      "messages",
      "send",
      {
        channel: "00000000-0000-4000-8000-000000000001",
        content: "attached",
        file: ["/tmp/a.png"],
      },
      ctx,
    );
    expect(ctx.published[0]).toMatchObject({
      tags: expect.arrayContaining([
        [
          "imeta",
          "url https://relay.example/media/a.png",
          "m image/png",
          `x ${"a".repeat(64)}`,
          "size 1234",
          "dim 640x480",
          "blurhash LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        ],
      ]),
    });
  });

  it("returns typed relay counts", async () => {
    const result = await executeCommand(
      "events",
      "count",
      { filter: { kinds: [1] } },
      context(),
    );
    expect(result).toEqual({ count: 3 });
  });

  it("fails closed on unsupported commands", async () => {
    await expect(
      executeCommand("unknown", "thing", {}, context()),
    ).rejects.toThrow("unsupported command");
  });

  it("encrypts agent draft requests exclusively to the attested owner", async () => {
    const ownerSecret = generateSecretKey();
    const owner = getPublicKey(ownerSecret);
    const ctx = context({
      authTag: ["auth", owner, "", "a".repeat(128)],
    });
    const result = await executeCommand(
      "agents",
      "draft-create",
      {
        channel: "00000000-0000-4000-8000-000000000001",
        displayName: "Research helper",
        systemPrompt: "Find primary sources.",
      },
      ctx,
    );
    const event = ctx.published[0] as Parameters<
      typeof decryptObserverPayload
    >[1];
    expect(event).toMatchObject({
      kind: 24_200,
      tags: expect.arrayContaining([
        ["p", owner],
        ["frame", "telemetry"],
      ]),
    });
    expect(decryptObserverPayload(ownerSecret, event)).toMatchObject({
      kind: "agent_management_request",
      payload: {
        action: "create",
        request: { displayName: "Research helper" },
      },
    });
    expect(result).toMatchObject({ accepted: true, saved: false });
  });

  it("preserves long-form note metadata on update", async () => {
    const ctx = context({
      query: vi.fn(async () => [
        signNostrEvent(
          {
            content: "old",
            created_at: unixNow() - 10,
            kind: 30_023,
            tags: [
              ["d", "playbook"],
              ["title", "Playbook"],
              ["summary", "Carry me"],
              ["t", "ops"],
              ["published_at", "100"],
            ],
          },
          generateSecretKey(),
        ),
      ]),
    });
    await executeCommand(
      "notes",
      "set",
      { content: "new", name: "playbook" },
      ctx,
    );
    expect(ctx.published[0]).toMatchObject({
      content: "new",
      kind: 30_023,
      tags: expect.arrayContaining([
        ["title", "Playbook"],
        ["summary", "Carry me"],
        ["t", "ops"],
        ["published_at", "100"],
      ]),
    });
  });

  it("surfaces dominated long-form writes as conflicts", async () => {
    const ctx = context({
      publishMessage: "duplicate: newer replaceable event exists",
    });
    await expect(
      executeCommand(
        "notes",
        "set",
        {
          allowEmpty: true,
          content: "",
          name: "playbook",
          title: "Playbook",
        },
        ctx,
      ),
    ).rejects.toThrow(/^conflict:/);
  });

  it("builds NIP-34 issue coordinates and recipients", async () => {
    const ctx = context();
    await executeCommand(
      "issues",
      "create",
      {
        content: "Details",
        labels: ["bug"],
        recipients: ["b".repeat(64)],
        repoId: "buzz",
        repoOwner: "a".repeat(64),
        title: "Fix it",
      },
      ctx,
    );
    expect(ctx.published[0]).toMatchObject({
      kind: 1_621,
      tags: expect.arrayContaining([
        ["a", `30617:${"a".repeat(64)}:buzz`],
        ["p", "b".repeat(64)],
        ["subject", "Fix it"],
        ["t", "bug"],
      ]),
    });
  });

  it("resolves member-only channel lists through membership snapshots", async () => {
    const memberSecret = generateSecretKey();
    const memberPubkey = getPublicKey(memberSecret);
    const channelId = "00000000-0000-4000-8000-000000000001";
    const membership = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: 39_002,
        tags: [
          ["d", channelId],
          ["p", memberPubkey],
        ],
      },
      generateSecretKey(),
    );
    const metadata = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: 39_000,
        tags: [
          ["d", channelId],
          ["name", "General"],
          ["about", "Company-wide"],
          ["public"],
        ],
      },
      generateSecretKey(),
    );
    const query = vi.fn(async (filters) =>
      filters[0]?.kinds?.[0] === 39_002 ? [membership] : [metadata],
    );
    const ctx = context({ query });
    ctx.secretKey.set(memberSecret);
    await expect(
      executeCommand(
        "channels",
        "list",
        { member: true, visibility: "open" },
        ctx,
      ),
    ).resolves.toEqual([
      {
        channel_id: channelId,
        created_at: metadata.created_at,
        description: "Company-wide",
        name: "General",
      },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("aborts an ambiguous template roster before creating the channel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buzz-cli-template-"));
    const templatesFile = join(directory, "channel-templates.json");
    try {
      await writeFile(
        templatesFile,
        JSON.stringify([
          {
            agents: { personas: [{ personaId: "builtin:fizz" }] },
            channel_type: "stream",
            name: "Buzz Team",
            visibility: "open",
          },
        ]),
      );
      const managed = ["a", "b"].map((prefix) =>
        signNostrEvent(
          {
            content: JSON.stringify({ persona_id: "builtin:fizz" }),
            created_at: unixNow(),
            kind: KIND_MANAGED_AGENT,
            tags: [["d", prefix.repeat(64)]],
          },
          generateSecretKey(),
        ),
      );
      const ctx = context({ query: vi.fn(async () => managed) });
      await expect(
        executeCommand(
          "channels",
          "create",
          {
            name: "Project",
            template: "buzz team",
            templatesFile,
          },
          ctx,
        ),
      ).rejects.toThrow("has 2 live instances");
      expect(ctx.published).toHaveLength(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

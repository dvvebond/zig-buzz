import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentModelService, normalizeAcpModels } from "./agent-models.js";
import { DesktopEventBus } from "./event-bus.js";
import { IdentityService } from "./identity.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentService } from "./managed-agents.js";
import { MeshComputeService } from "./mesh-compute.js";
import { RuntimeCatalogService } from "./runtime-catalog.js";

describe("AgentModelService", () => {
  it("discovers and normalizes OpenAI text models without exposing snapshots twice", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:43111/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-openai-secret",
      );
      return jsonResponse({
        data: [
          { created: 3, id: "gpt-5" },
          { created: 2, id: "gpt-5-2026-07-01" },
          { created: 1, id: "text-embedding-3-large" },
          { created: 4, id: "o4-mini" },
        ],
      });
    });
    const service = fixture(fetcher);
    const result = await service.discover({
      input: {
        agentCommand: "buzz-agent",
        envVars: {
          OPENAI_COMPAT_API_KEY: "test-openai-secret",
          OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:43111/v1",
        },
        provider: "openai",
      },
    });
    expect(result).toMatchObject({
      agentName: "openai",
      agentVersion: "models-api",
      supportsSwitching: true,
    });
    expect(result.models).toEqual([
      {
        description: null,
        id: "o4-mini",
        name: "o4-mini",
      },
      {
        description: null,
        id: "gpt-5",
        name: "GPT-5",
      },
    ]);
  });

  it("paginates Anthropic and redacts credentials from HTTP errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("after_id")) {
        return jsonResponse({
          data: [{ display_name: "Claude Opus", id: "claude-opus-4-1" }],
          has_more: true,
          last_id: "claude-opus-4-1",
        });
      }
      return jsonResponse({
        data: [{ display_name: "Claude Sonnet", id: "claude-sonnet-4-1" }],
        has_more: false,
      });
    });
    const service = fixture(fetcher);
    const result = await service.discover({
      input: {
        agentCommand: "buzz-agent",
        envVars: {
          ANTHROPIC_API_KEY: "test-anthropic-secret",
          ANTHROPIC_BASE_URL: "http://localhost:43112",
        },
        provider: "anthropic",
      },
    });
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-opus-4-1",
      "claude-sonnet-4-1",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const rejected = fixture(
      async () =>
        new Response("bad token test-anthropic-secret", { status: 401 }),
    );
    await expect(
      rejected.discover({
        input: {
          agentCommand: "buzz-agent",
          envVars: {
            ANTHROPIC_API_KEY: "test-anthropic-secret",
            ANTHROPIC_BASE_URL: "http://localhost:43112",
          },
          provider: "anthropic",
        },
      }),
    ).rejects.toThrow(/bad token \[REDACTED\]/);
  });

  it("filters Databricks endpoints that cannot serve chat traffic", async () => {
    const service = fixture(async () =>
      jsonResponse({
        endpoints: [
          {
            name: "chat-ready",
            state: { ready: "READY" },
            task: "llm/v1/chat",
          },
          {
            name: "not-ready",
            state: { ready: "NOT_READY" },
            task: "llm/v1/chat",
          },
          {
            name: "embedding-ready",
            state: { ready: "READY" },
            task: "llm/v1/embedding",
          },
        ],
      }),
    );
    const result = await service.discover({
      input: {
        agentCommand: "buzz-agent",
        envVars: {
          DATABRICKS_HOST: "http://127.0.0.1:43113",
          DATABRICKS_TOKEN: "test-databricks-secret",
        },
        provider: "databricks",
      },
    });
    expect(result.models).toEqual([
      { description: null, id: "chat-ready", name: "chat-ready" },
    ]);
  });

  it("normalizes grouped ACP model options and unstable fallbacks", () => {
    expect(
      normalizeAcpModels(
        { agentInfo: { name: "Goose", version: "1.2.3" } },
        {
          _meta: {
            models: {
              availableModels: [
                {
                  description: "Fallback",
                  modelId: "unstable-only",
                  name: "Unstable",
                },
                { modelId: "stable", name: "Duplicate" },
              ],
              currentModelId: "stable",
            },
          },
          configOptions: [
            {
              category: "model",
              currentValue: "stable",
              options: [
                {
                  group: "recommended",
                  name: "Recommended",
                  options: [
                    {
                      description: "Stable model",
                      name: "Stable",
                      value: "stable",
                    },
                  ],
                },
              ],
              type: "select",
            },
          ],
        },
        "persisted",
      ),
    ).toEqual({
      agentDefaultModel: "stable",
      agentName: "Goose",
      agentVersion: "1.2.3",
      models: [
        {
          description: "Stable model",
          id: "stable",
          name: "Stable",
        },
        {
          description: "Fallback",
          id: "unstable-only",
          name: "Unstable",
        },
      ],
      selectedModel: "persisted",
      supportsSwitching: true,
    });
  });

  it("rejects insecure non-loopback provider URLs and reserved environment keys", async () => {
    const service = fixture(async () => jsonResponse({ data: [] }));
    await expect(
      service.discover({
        input: {
          agentCommand: "buzz-agent",
          envVars: {
            OPENAI_COMPAT_API_KEY: "secret",
            OPENAI_COMPAT_BASE_URL: "http://provider.example/v1",
          },
          provider: "openai",
        },
      }),
    ).rejects.toThrow(/requires HTTPS/);
    await expect(
      service.discover({
        input: {
          agentCommand: "buzz-agent",
          envVars: { BUZZ_PRIVATE_KEY: "must-not-pass" },
        },
      }),
    ).rejects.toThrow(/invalid or reserved/);
  });
});

function fixture(fetcher: typeof fetch): AgentModelService {
  const identity = IdentityService.create(undefined, async () => undefined);
  const localEntities = new LocalEntityService(identity);
  const runtimeCatalog = new RuntimeCatalogService(identity);
  const managedAgents = new ManagedAgentService({
    dataDirectory: path.join(os.tmpdir(), "buzz-agent-model-test"),
    defaultRelayUrl: "ws://127.0.0.1:3000",
    identity,
    localEntities,
    runtimeCatalog,
  });
  const mesh = new MeshComputeService({
    dataDirectory: path.join(os.tmpdir(), "buzz-agent-model-test-mesh"),
    events: new DesktopEventBus(),
    identity,
    workspace: { relayUrl: () => "ws://127.0.0.1:3000" },
  });
  return new AgentModelService({
    fetch: fetcher,
    localEntities,
    managedAgents,
    mesh,
    runtimeCatalog,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

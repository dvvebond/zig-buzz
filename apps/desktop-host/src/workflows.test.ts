import { describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import type { RelayHttpClient } from "./relay-http.js";
import { WorkflowService } from "./workflows.js";

const CHANNEL_ID = "f7f4877b-d739-4c4e-99c7-9f642a582a1b";
const WEBHOOK_YAML = `
name: Incoming
trigger: { on: webhook }
steps:
  - { id: notify, action: send_message, text: received }
`;

describe("WorkflowService", () => {
  it("returns a newly issued webhook secret from the relay acknowledgement", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const secret = "4ef6fd99-80ea-4613-a465-c973975f40b4";
    const relay = {
      publish: async () => ({
        eventId: "a".repeat(64),
        message: `response:${JSON.stringify({
          webhook_secret: secret,
          workflow_id: "unused",
        })}`,
      }),
      query: async () => [],
    } as unknown as RelayHttpClient;

    const result = await new WorkflowService(identity, relay).create(
      CHANNEL_ID,
      WEBHOOK_YAML,
    );

    expect(result.webhook_secret).toBe(secret);
    expect(result.channel_id).toBe(CHANNEL_ID);
    expect(result.owner_pubkey).toBe(identity.info().pubkey);
  });

  it("does not trust malformed or oversized acknowledgement secrets", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    for (const message of [
      "stored",
      "response:not-json",
      `response:${JSON.stringify({ webhook_secret: "x".repeat(257) })}`,
      `response:${JSON.stringify({ webhook_secret: 123 })}`,
    ]) {
      const relay = {
        publish: async () => ({
          eventId: "a".repeat(64),
          message,
        }),
        query: async () => [],
      } as unknown as RelayHttpClient;
      const result = await new WorkflowService(identity, relay).create(
        CHANNEL_ID,
        WEBHOOK_YAML,
      );
      expect(result.webhook_secret).toBeNull();
    }
  });
});

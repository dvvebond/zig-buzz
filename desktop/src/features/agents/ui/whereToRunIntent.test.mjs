import assert from "node:assert/strict";
import test from "node:test";

import {
  canSubmitWhereToRun,
  emptyWhereToRunDraft,
  providerConfigComplete,
  resolveBackendIntent,
} from "./whereToRunIntent.ts";

const probed = {
  ok: true,
  config_schema: {
    properties: { region: { type: "string" }, size: { type: "integer" } },
    required: ["region"],
  },
};

function providerDraft(overrides = {}) {
  return {
    ...emptyWhereToRunDraft,
    runOn: "blox",
    probedProvider: probed,
    providerConfig: { region: "us", size: "3" },
    ...overrides,
  };
}

test("provider selection blocks submit until the probe completes", () => {
  assert.equal(
    canSubmitWhereToRun(providerDraft({ probedProvider: null })),
    false,
  );
});

test("provider selection blocks submit while required config is missing", () => {
  const missing = providerDraft({ providerConfig: { size: "3" } });
  assert.equal(canSubmitWhereToRun(missing), false);
  assert.equal(providerConfigComplete(missing), false);
});

test("complete provider config allows submit", () => {
  assert.equal(canSubmitWhereToRun(providerDraft()), true);
});

test("local never gates submit", () => {
  assert.equal(canSubmitWhereToRun(emptyWhereToRunDraft), true);
});

test("local draft resolves to null intent", () => {
  assert.equal(resolveBackendIntent(emptyWhereToRunDraft), null);
});

test("provider draft resolves with coerced config values", () => {
  const intent = resolveBackendIntent(providerDraft());
  assert.deepEqual(intent, {
    type: "provider",
    id: "blox",
    config: { region: "us", size: 3 },
  });
});

test("remote server blocks submit until its secure session is ready", () => {
  const draft = {
    ...emptyWhereToRunDraft,
    runOn: "remote-server",
    remote: {
      enrollmentId: "c15e3cf6-d2ea-4b27-8e9e-2d2a0df4a92b",
      expiresAt: 1_785_250_600,
      ready: false,
      setupCommand: "buzz-remote-agent ...",
      workerPubkey: "a".repeat(64),
    },
  };
  assert.equal(canSubmitWhereToRun(draft), false);
  assert.equal(resolveBackendIntent(draft), null);
});

test("ready remote server resolves to a key-bound deployment intent", () => {
  const draft = {
    ...emptyWhereToRunDraft,
    runOn: "remote-server",
    remote: {
      enrollmentId: "c15e3cf6-d2ea-4b27-8e9e-2d2a0df4a92b",
      expiresAt: 1_785_250_600,
      ready: true,
      setupCommand: "buzz-remote-agent ...",
      workerPubkey: "a".repeat(64),
    },
  };
  assert.equal(canSubmitWhereToRun(draft), true);
  assert.deepEqual(resolveBackendIntent(draft), {
    type: "remote",
    deploymentId: "c15e3cf6-d2ea-4b27-8e9e-2d2a0df4a92b",
    workerPubkey: "a".repeat(64),
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  ConditionEvaluationError,
  evaluateCondition,
  isPublicAddress,
  parseDurationSeconds,
  parseWorkflowYaml,
  resolveTemplate,
  WorkflowEngine,
  type TriggerContext,
  type WorkflowActionSink,
} from "./index.js";

const trigger: TriggerContext = {
  author: "a".repeat(64),
  channelId: "123e4567-e89b-42d3-a456-426614174000",
  emoji: "",
  messageId: "b".repeat(64),
  text: "P1 production incident",
  timestamp: 1_700_000_000,
  webhookFields: { severity: "critical" },
};

describe("workflow definitions", () => {
  it("parses every trigger/action shape and supplies enabled=true", () => {
    const parsed = parseWorkflowYaml(`
name: Incident triage
trigger:
  on: message_posted
  filter: str_contains(trigger_text, "P1")
steps:
  - id: notify
    if: str_len(trigger_text) > 5
    action: send_message
    text: "Alert: {{trigger.text}}"
  - id: approve
    action: request_approval
    from: "{{trigger.author}}"
    message: Ship?
    timeout: 4h
`);
    expect(parsed.definition.enabled).toBe(true);
    expect(parsed.definition.steps).toHaveLength(2);
    expect(JSON.parse(parsed.canonicalJson)).toEqual(parsed.definition);
  });

  it("rejects duplicate step IDs, unsafe IDs, invalid schedules, and long delays", () => {
    expect(() =>
      parseWorkflowYaml(`
name: bad
trigger: { on: schedule, interval: 30s }
steps:
  - { id: bad-id, action: delay, duration: 5m }
  - { id: bad-id, action: delay, duration: 5m }
`),
    ).toThrow();
    expect(() =>
      parseWorkflowYaml(`
name: bad delay
trigger: { on: webhook }
steps:
  - { id: wait, action: delay, duration: 5m }
`),
    ).toThrow("delay exceeds 270 seconds");
  });

  it("parses bounded durations", () => {
    expect(parseDurationSeconds("30")).toBe(30);
    expect(parseDurationSeconds("5m")).toBe(300);
    expect(parseDurationSeconds("2h")).toBe(7_200);
    expect(() => parseDurationSeconds("-1m")).toThrow();
  });
});

describe("workflow templates and conditions", () => {
  it("resolves trigger and step outputs in a single pass", () => {
    expect(
      resolveTemplate(
        "{{trigger.text | truncate(2)}} {{steps.first.output.count}} {{unknown}}",
        trigger,
        { first: { count: 3 } },
      ),
    ).toBe("P1 3 {{unknown}}");
  });

  it("evaluates the bounded expression language without JavaScript eval", () => {
    expect(
      evaluateCondition(
        'str_contains(trigger_text, "P1") && str_starts_with(trigger_severity, "crit") && str_len(trigger_author) == 64',
        trigger,
        {},
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        'str_ends_with(steps_first_output_label, "done") || trigger_emoji != ""',
        trigger,
        { first: { label: "all done" } },
      ),
    ).toBe(true);
    expect(() =>
      evaluateCondition("constructor.constructor()", trigger, {}),
    ).toThrow(ConditionEvaluationError);
  });
});

describe("workflow execution", () => {
  it("executes sequential actions, templates outputs, and skips false conditions", async () => {
    const sink = fakeSink();
    const definition = parseWorkflowYaml(`
name: Execute
trigger: { on: message_posted }
steps:
  - id: one
    action: send_message
    text: "{{trigger.text}}"
  - id: skip
    if: trigger_emoji != ""
    action: add_reaction
    emoji: eyes
  - id: topic
    action: set_channel_topic
    topic: "{{steps.one.output.eventId}}"
`).definition;
    const result = await new WorkflowEngine(sink).execute({
      communityId: "community-id",
      definition,
      ownerPubkey: trigger.author,
      trigger,
      workflowChannelId: trigger.channelId,
      workflowId: "workflow-id",
    });

    expect(result.status).toBe("completed");
    expect(result.trace.map((entry) => entry.status)).toEqual([
      "completed",
      "skipped",
      "completed",
    ]);
    expect(sink.sendMessage).toHaveBeenCalledOnce();
    expect(sink.setChannelTopic).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "message-event" }),
    );
  });

  it("suspends at an approval gate with a bounded, expiring token", async () => {
    const definition = parseWorkflowYaml(`
name: Approval
trigger: { on: webhook }
steps:
  - id: gate
    action: request_approval
    from: "{{trigger.author}}"
    message: approve
    timeout: 1h
  - id: later
    action: send_message
    text: later
`).definition;
    const result = await new WorkflowEngine(fakeSink()).execute({
      communityId: "community-id",
      definition,
      ownerPubkey: trigger.author,
      trigger,
      workflowId: "workflow-id",
    });
    expect(result.status).toBe("waiting_approval");
    if (result.status === "waiting_approval") {
      expect(result.approval.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(result.currentStep).toBe(0);
    }
  });

  it("fails a step safely without running later actions", async () => {
    const sink = fakeSink();
    sink.sendMessage.mockRejectedValueOnce(new Error("provider\nsecret"));
    const definition = parseWorkflowYaml(`
name: Failure
trigger: { on: message_posted }
steps:
  - { id: fail, action: send_message, text: hi }
  - { id: later, action: send_message, text: later }
`).definition;
    const result = await new WorkflowEngine(sink).execute({
      communityId: "community-id",
      definition,
      ownerPubkey: trigger.author,
      trigger,
      workflowChannelId: trigger.channelId,
      workflowId: "workflow-id",
    });
    expect(result.status).toBe("failed");
    expect(sink.sendMessage).toHaveBeenCalledOnce();
    if (result.status === "failed") {
      expect(result.error).toBe("provider secret");
    }
  });
});

describe("webhook address policy", () => {
  it("rejects private, loopback, link-local, documentation, and multicast ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "203.0.113.2",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});

function fakeSink() {
  return {
    addReaction: vi.fn<WorkflowActionSink["addReaction"]>(async () => ({
      eventId: "reaction-event",
    })),
    sendDm: vi.fn<WorkflowActionSink["sendDm"]>(async () => ({
      eventId: "dm-event",
    })),
    sendMessage: vi.fn<WorkflowActionSink["sendMessage"]>(async () => ({
      eventId: "message-event",
    })),
    setChannelTopic: vi.fn<WorkflowActionSink["setChannelTopic"]>(async () => ({
      eventId: "topic-event",
    })),
  };
}

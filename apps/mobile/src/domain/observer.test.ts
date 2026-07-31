import { describe, expect, it } from "vitest";

import { buildObserverTranscript, parseObserverFrame } from "./observer";

describe("agent observer transcript", () => {
  it("rejects malformed frames", () => {
    expect(parseObserverFrame({ kind: "acp_read", seq: -1 })).toBeUndefined();
  });

  it("coalesces streamed messages and tool updates", () => {
    const base = {
      channelId: "channel",
      kind: "acp_read",
      sessionId: "session",
      timestamp: "2026-07-29T10:00:00.000Z",
    };
    const transcript = buildObserverTranscript([
      {
        ...base,
        payload: {
          method: "session/update",
          params: {
            update: {
              content: [{ text: "Hel" }],
              messageId: "m1",
              sessionUpdate: "agent_message_chunk",
            },
          },
        },
        seq: 1,
      },
      {
        ...base,
        payload: {
          method: "session/update",
          params: {
            update: {
              content: [{ text: "lo" }],
              messageId: "m1",
              sessionUpdate: "agent_message_chunk",
            },
          },
        },
        seq: 2,
      },
      {
        ...base,
        payload: {
          method: "session/update",
          params: {
            update: {
              args: { channel: "general" },
              status: "completed",
              toolCallId: "t1",
              toolName: "send_message",
              sessionUpdate: "tool_call_update",
            },
          },
        },
        seq: 3,
      },
    ]);
    expect(transcript[0]).toMatchObject({ text: "Hello", type: "message" });
    expect(transcript[1]).toMatchObject({
      status: "completed",
      toolName: "send_message",
      type: "tool",
    });
  });
});

import type {
  AgentContext,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";

const MAX_SESSIONS = 256;
const MAX_PROMPT_BYTES = 1024 * 1024;

export type ModelMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

export type ModelTurnInput = {
  readonly history: readonly ModelMessage[];
  readonly prompt: string;
  readonly instructions?: string;
  readonly signal: AbortSignal;
  readonly onText: (delta: string) => Promise<void>;
};

export type ModelTurnResult = {
  readonly text: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
};

export type ModelRunner = {
  run(input: ModelTurnInput): Promise<ModelTurnResult>;
};

type Session = {
  readonly id: string;
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly history: ModelMessage[];
  activeTurn?: AbortController;
};

export class BuzzAgent {
  readonly #sessions = new Map<string, Session>();

  public constructor(private readonly runner: ModelRunner) {}

  public initialize(request: InitializeRequest): InitializeResponse {
    if (request.protocolVersion !== 1 && request.protocolVersion !== 2) {
      throw new Error(
        `unsupported ACP protocol version ${request.protocolVersion}`,
      );
    }
    return {
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          audio: false,
          embeddedContext: true,
          image: false,
        },
      },
      agentInfo: { name: "buzz-agent-ts", version: "0.1.0" },
      protocolVersion: request.protocolVersion,
    };
  }

  public newSession(request: NewSessionRequest): NewSessionResponse {
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw new Error("agent session limit reached");
    }
    const id = crypto.randomUUID();
    const systemPrompt = metaString(request._meta, "systemPrompt");
    this.#sessions.set(id, {
      cwd: request.cwd,
      history: [],
      id,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    return { sessionId: id };
  }

  public async prompt(
    request: PromptRequest,
    client: AgentContext,
    requestSignal: AbortSignal,
  ): Promise<PromptResponse> {
    const session = this.#requireSession(request.sessionId);
    if (session.activeTurn) {
      throw new Error("session already has an active prompt");
    }
    const prompt = textFromPrompt(request.prompt);
    const controller = new AbortController();
    session.activeTurn = controller;
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    const messageId = crypto.randomUUID();
    try {
      const result = await this.runner.run({
        history: session.history,
        instructions: session.systemPrompt ?? DEFAULT_INSTRUCTIONS,
        onText: async (delta) => {
          if (!delta) return;
          await client.notify("session/update", {
            sessionId: session.id,
            update: {
              content: { text: delta, type: "text" },
              messageId,
              sessionUpdate: "agent_message_chunk",
            },
          });
        },
        prompt,
        signal,
      });
      appendHistory(session.history, { content: prompt, role: "user" });
      appendHistory(session.history, {
        content: result.text,
        role: "assistant",
      });
      return {
        stopReason: "end_turn",
        ...(result.usage
          ? {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalTokens:
                  result.usage.inputTokens + result.usage.outputTokens,
              },
            }
          : {}),
      };
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      delete session.activeTurn;
    }
  }

  public cancel(sessionId: string): void {
    this.#requireSession(sessionId).activeTurn?.abort(
      new Error("ACP turn cancelled"),
    );
  }

  #requireSession(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("unknown ACP session");
    return session;
  }
}

const DEFAULT_INSTRUCTIONS = [
  "You are a Buzz workspace agent.",
  "Answer the user's request accurately and directly.",
  "For requests to inspect or explain, do not make external changes.",
  "For requests to change or build, perform only the in-scope work exposed by your tools.",
  "Require confirmation before destructive, external, costly, or scope-expanding actions.",
].join("\n");

function textFromPrompt(blocks: PromptRequest["prompt"]): string {
  const text = blocks
    .filter(
      (block): block is Extract<(typeof blocks)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n");
  if (!text || Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    throw new RangeError("prompt text must be between 1 byte and 1 MiB");
  }
  return text;
}

function metaString(
  meta: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES
    ? value
    : undefined;
}

function appendHistory(history: ModelMessage[], message: ModelMessage): void {
  history.push(message);
  while (
    history.length > 100 ||
    history.reduce(
      (size, item) => size + Buffer.byteLength(item.content, "utf8"),
      0,
    ) >
      4 * 1024 * 1024
  ) {
    history.shift();
  }
}

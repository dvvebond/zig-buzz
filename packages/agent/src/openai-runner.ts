import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
} from "openai/resources/responses/responses";

import type {
  ModelMessage,
  ModelRunner,
  ModelTurnInput,
  ModelTurnResult,
} from "./agent.js";

export type OpenAiResponsesRunnerOptions = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maximumOutputTokens?: number;
  readonly reasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  readonly client?: OpenAI;
};

export class OpenAiResponsesRunner implements ModelRunner {
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #maximumOutputTokens: number;
  readonly #hasCredentials: boolean;
  readonly #reasoningEffort: NonNullable<
    OpenAiResponsesRunnerOptions["reasoningEffort"]
  >;

  public constructor(options: OpenAiResponsesRunnerOptions = {}) {
    const baseURL = options.baseUrl ?? process.env.OPENAI_BASE_URL;
    if (baseURL) validateBaseUrl(baseURL);
    this.#client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? "missing",
        ...(baseURL ? { baseURL } : {}),
        maxRetries: 2,
        timeout: 10 * 60_000,
      });
    this.#hasCredentials = Boolean(
      options.client || options.apiKey || process.env.OPENAI_API_KEY,
    );
    this.#model =
      options.model ?? process.env.BUZZ_AGENT_MODEL ?? "gpt-5.6-sol";
    this.#maximumOutputTokens = validateInteger(
      options.maximumOutputTokens ??
        parseInteger(process.env.BUZZ_AGENT_MAX_OUTPUT_TOKENS) ??
        16_384,
      "maximum output tokens",
      1,
      128_000,
    );
    this.#reasoningEffort =
      options.reasoningEffort ??
      parseReasoningEffort(process.env.BUZZ_AGENT_REASONING_EFFORT) ??
      "medium";
  }

  public async run(input: ModelTurnInput): Promise<ModelTurnResult> {
    if (!this.#hasCredentials) {
      throw new Error("OPENAI_API_KEY is required for buzz-agent-ts");
    }
    const request: ResponseCreateParamsStreaming = {
      input: buildInput(input.history, input.prompt),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      max_output_tokens: this.#maximumOutputTokens,
      model: this.#model,
      reasoning: { effort: this.#reasoningEffort },
      store: false,
      stream: true,
      text: { verbosity: "medium" },
    };
    const stream = await this.#client.responses.create(request, {
      signal: input.signal,
    });
    let text = "";
    let usage: ModelTurnResult["usage"];
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        await input.onText(event.delta);
      } else if (event.type === "response.completed") {
        usage = {
          inputTokens: event.response.usage?.input_tokens ?? 0,
          outputTokens: event.response.usage?.output_tokens ?? 0,
        };
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
    return { text, ...(usage ? { usage } : {}) };
  }
}

function buildInput(
  history: readonly ModelMessage[],
  prompt: string,
): ResponseInput {
  return [
    ...history.map((message) => ({
      content: message.content,
      role: message.role,
    })),
    { content: prompt, role: "user" as const },
  ];
}

function validateBaseUrl(value: string): void {
  const url = new URL(value);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new TypeError(
      "OPENAI_BASE_URL must use HTTPS and must not contain credentials",
    );
  }
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseReasoningEffort(
  value: string | undefined,
): OpenAiResponsesRunnerOptions["reasoningEffort"] {
  return value &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? (value as NonNullable<OpenAiResponsesRunnerOptions["reasoningEffort"]>)
    : undefined;
}

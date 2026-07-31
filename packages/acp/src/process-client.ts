import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  Readable,
  Transform,
  Writable,
  type TransformCallback,
} from "node:stream";

import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

const MAX_NDJSON_LINE_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const SENSITIVE_ENVIRONMENT_KEYS = new Set([
  "BUZZ_PRIVATE_KEY",
  "BUZZ_NSEC",
  "BUZZ_REMOTE_AGENT_STATE_KEY",
  "NOSTR_PRIVATE_KEY",
]);

export type PermissionPolicy =
  | "allow-once"
  | "deny"
  | ((
      request: RequestPermissionRequest,
    ) => Promise<RequestPermissionResponse> | RequestPermissionResponse);

export type AcpProcessEvent =
  | { readonly type: "update"; readonly notification: SessionNotification }
  | { readonly type: "stderr"; readonly text: string }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export type AcpProcessClientOptions = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly inheritEnvironment?: boolean;
  readonly permissionPolicy?: PermissionPolicy;
  readonly requestTimeoutMilliseconds?: number;
  readonly turnTimeoutMilliseconds?: number;
};

export class AcpProcessClient {
  readonly #options: ValidatedOptions;
  readonly #listeners = new Set<(event: AcpProcessEvent) => void>();
  readonly #stderr: string[] = [];
  #stderrBytes = 0;
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientConnection | undefined;
  #initializeResponse: InitializeResponse | undefined;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: AcpProcessClientOptions) {
    this.#options = validateOptions(options);
  }

  public get initialized(): boolean {
    return this.#initializeResponse !== undefined;
  }

  public get initializeResponse(): InitializeResponse | undefined {
    return this.#initializeResponse
      ? structuredClone(this.#initializeResponse)
      : undefined;
  }

  public get stderrTail(): string {
    return this.#stderr.join("");
  }

  public on(listener: (event: AcpProcessEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async start(): Promise<InitializeResponse> {
    if (this.#child || this.#connection) {
      throw new Error("ACP process is already started");
    }
    const child = spawn(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd,
      detached: process.platform !== "win32",
      env: buildChildEnvironment(this.#options),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.#captureStderr(chunk));
    child.once("exit", (code, signal) => {
      this.#emit({ code, signal, type: "exit" });
      this.#connection?.close(
        new Error(`ACP process exited (${code ?? signal ?? "unknown"})`),
      );
      this.#connection = undefined;
      this.#child = undefined;
      this.#initializeResponse = undefined;
    });
    child.once("error", (error) => {
      this.#connection?.close(error);
    });

    const boundedOutput = child.stdout.pipe(
      new BoundedLineTransform(MAX_NDJSON_LINE_BYTES),
    );
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(boundedOutput) as ReadableStream<Uint8Array>,
    );
    const app = client({ name: "buzz-acp" })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        decidePermission(this.#options.permissionPolicy, params),
      )
      .onNotification(methods.client.session.update, ({ params }) => {
        this.#emit({ notification: structuredClone(params), type: "update" });
      });
    const connection = app.connect(stream);
    this.#connection = connection;
    try {
      const response = await connection.agent.request(
        methods.agent.initialize,
        {
          clientCapabilities: {
            auth: { terminal: true },
            _meta: {
              goose: { customNotifications: true },
              "terminal-auth": true,
            },
          },
          clientInfo: { name: "buzz-acp", version: "0.1.0" },
          // The existing Buzz harness negotiates legacy ACP wire version 2.
          // This remains configurable only through a code release so a hostile
          // environment cannot silently downgrade the protocol.
          protocolVersion: 2,
        },
        {
          cancellationSignal: AbortSignal.timeout(
            this.#options.requestTimeoutMilliseconds,
          ),
        },
      );
      if (response.protocolVersion !== 1 && response.protocolVersion !== 2) {
        throw new Error(
          `ACP agent selected unsupported protocol version ${response.protocolVersion}`,
        );
      }
      this.#initializeResponse = response;
      return structuredClone(response);
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  public async newSession(
    input: {
      readonly cwd?: string;
      readonly mcpServers?: readonly McpServer[];
      readonly systemPrompt?: string;
      readonly sessionTitle?: string;
    } = {},
  ): Promise<NewSessionResponse> {
    const connection = this.#requireInitialized();
    const cwd = input.cwd ?? this.#options.cwd;
    if (!isAbsolute(cwd))
      throw new TypeError("ACP session cwd must be absolute");
    const systemPrompt = input.systemPrompt?.trim();
    const sessionTitle = input.sessionTitle?.trim();
    if (
      systemPrompt &&
      Buffer.byteLength(systemPrompt, "utf8") > MAX_PROMPT_BYTES
    ) {
      throw new RangeError("ACP system prompt exceeds 1 MiB");
    }
    const request: NewSessionRequest = {
      cwd,
      mcpServers:
        input.mcpServers?.map((server) => structuredClone(server)) ?? [],
      ...(systemPrompt || sessionTitle
        ? {
            _meta: {
              ...(systemPrompt ? { systemPrompt } : {}),
              ...(sessionTitle ? { sessionTitle } : {}),
            },
          }
        : {}),
    };
    const response = await connection.agent.request<
      NewSessionResponse,
      NewSessionRequest
    >(methods.agent.session.new, request, {
      cancellationSignal: AbortSignal.timeout(
        this.#options.requestTimeoutMilliseconds,
      ),
    });
    return structuredClone(response);
  }

  public async authenticate(methodId: string): Promise<void> {
    if (
      typeof methodId !== "string" ||
      methodId.trim() === "" ||
      Buffer.byteLength(methodId, "utf8") > 256
    ) {
      throw new TypeError("ACP authentication method ID is invalid");
    }
    await this.#requireInitialized().agent.request(
      methods.agent.authenticate,
      { methodId },
      {
        cancellationSignal: AbortSignal.timeout(
          this.#options.requestTimeoutMilliseconds,
        ),
      },
    );
  }

  public async prompt(
    sessionId: string,
    prompt: string | readonly string[],
    signal?: AbortSignal,
  ): Promise<PromptResponse> {
    const connection = this.#requireInitialized();
    validateSessionId(sessionId);
    const blocks = (typeof prompt === "string" ? [prompt] : prompt).map(
      (text) => ({ text, type: "text" as const }),
    );
    const size = blocks.reduce(
      (total, block) => total + Buffer.byteLength(block.text, "utf8"),
      0,
    );
    if (blocks.length < 1 || blocks.length > 100 || size > MAX_PROMPT_BYTES) {
      throw new RangeError(
        "ACP prompt must contain 1-100 text blocks totaling at most 1 MiB",
      );
    }
    const timeout = AbortSignal.timeout(this.#options.turnTimeoutMilliseconds);
    const cancellationSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    return connection.agent.request(
      methods.agent.session.prompt,
      { prompt: blocks, sessionId },
      { cancellationSignal },
    );
  }

  public async cancel(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    await this.#requireInitialized().agent.notify(
      methods.agent.session.cancel,
      { sessionId },
    );
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = this.#shutdown().finally(() => {
      this.#shutdownPromise = undefined;
    });
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    const connection = this.#connection;
    const child = this.#child;
    this.#connection = undefined;
    this.#initializeResponse = undefined;
    connection?.close(new Error("ACP client shutdown"));
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.#child = undefined;
      return;
    }
    signalProcess(child, "SIGTERM");
    const exited = await waitForExit(child, 3_000);
    if (!exited) {
      signalProcess(child, "SIGKILL");
      await waitForExit(child, 3_000);
    }
    this.#child = undefined;
  }

  #captureStderr(text: string): void {
    const sanitized = text
      .slice(0, MAX_STDERR_BYTES)
      .replaceAll(/(?:nsec1|brap1_)[A-Za-z0-9_-]+/g, "[REDACTED]");
    this.#stderr.push(sanitized);
    this.#stderrBytes += Buffer.byteLength(sanitized, "utf8");
    while (this.#stderrBytes > MAX_STDERR_BYTES && this.#stderr.length > 1) {
      const removed = this.#stderr.shift() ?? "";
      this.#stderrBytes -= Buffer.byteLength(removed, "utf8");
    }
    this.#emit({ text: sanitized, type: "stderr" });
  }

  #requireInitialized(): ClientConnection {
    if (!this.#connection || !this.#initializeResponse) {
      throw new Error("ACP process is not initialized");
    }
    return this.#connection;
  }

  #emit(event: AcpProcessEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

type ValidatedOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly inheritEnvironment: boolean;
  readonly permissionPolicy: PermissionPolicy;
  readonly requestTimeoutMilliseconds: number;
  readonly turnTimeoutMilliseconds: number;
};

function validateOptions(options: AcpProcessClientOptions): ValidatedOptions {
  if (
    !options.command ||
    options.command.includes("\0") ||
    Buffer.byteLength(options.command, "utf8") > 4_096
  ) {
    throw new TypeError("ACP command is invalid");
  }
  if (!isAbsolute(options.cwd)) {
    throw new TypeError("ACP working directory must be absolute");
  }
  const args = options.args ?? [];
  if (
    args.length > 256 ||
    args.some(
      (arg) => arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 64 * 1024,
    )
  ) {
    throw new TypeError("ACP arguments are invalid");
  }
  const environment = options.environment ?? {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 1024 * 1024 ||
      SENSITIVE_ENVIRONMENT_KEYS.has(name)
    ) {
      throw new TypeError(`ACP environment variable ${name} is not allowed`);
    }
  }
  return {
    args: [...args],
    command: options.command,
    cwd: options.cwd,
    environment: { ...environment },
    inheritEnvironment: options.inheritEnvironment ?? true,
    permissionPolicy: options.permissionPolicy ?? "allow-once",
    requestTimeoutMilliseconds: validateDuration(
      options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "request timeout",
      1_000,
      10 * 60_000,
    ),
    turnTimeoutMilliseconds: validateDuration(
      options.turnTimeoutMilliseconds ?? DEFAULT_TURN_TIMEOUT_MS,
      "turn timeout",
      10_000,
      24 * 60 * 60_000,
    ),
  };
}

function buildChildEnvironment(options: ValidatedOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = options.inheritEnvironment
    ? { ...process.env }
    : {};
  for (const name of SENSITIVE_ENVIRONMENT_KEYS) delete environment[name];
  delete environment.NODE_OPTIONS;
  for (const [name, value] of Object.entries(options.environment)) {
    environment[name] = value;
  }
  return environment;
}

async function decidePermission(
  policy: PermissionPolicy,
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  if (typeof policy === "function") return policy(structuredClone(request));
  const preferredKind = policy === "allow-once" ? "allow_once" : "reject_once";
  const fallbackKind =
    policy === "allow-once" ? "allow_always" : "reject_always";
  const option =
    request.options.find((candidate) => candidate.kind === preferredKind) ??
    request.options.find((candidate) => candidate.kind === fallbackKind);
  return option
    ? { outcome: { optionId: option.optionId, outcome: "selected" } }
    : { outcome: { outcome: "cancelled" } };
}

function validateSessionId(sessionId: string): void {
  if (
    sessionId.length < 1 ||
    sessionId.length > 1_024 ||
    sessionId.includes("\0")
  ) {
    throw new TypeError("ACP session ID is invalid");
  }
}

function validateDuration(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside the accepted range`);
  }
  return value;
}

function signalProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, milliseconds);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

class BoundedLineTransform extends Transform {
  #lineBytes = 0;

  public constructor(private readonly maximumLineBytes: number) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    for (const byte of chunk) {
      if (byte === 0x0a) this.#lineBytes = 0;
      else {
        this.#lineBytes += 1;
        if (this.#lineBytes > this.maximumLineBytes) {
          callback(new Error("ACP agent emitted an oversized NDJSON line"));
          return;
        }
      }
    }
    callback(null, chunk);
  }
}

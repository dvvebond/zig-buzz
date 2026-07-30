import { HuddleAudioTransport } from "./huddleAudioTransport";
import { HuddleTranscription } from "./huddleTranscription";

type Callback = (value: unknown) => void;

type TauriInternals = {
  convertFileSrc(filePath: string, protocol?: string): string;
  invoke(command: string, args?: unknown, options?: unknown): Promise<unknown>;
  metadata: {
    currentWebview: { label: string; windowLabel: string };
    currentWindow: { label: string };
  };
  transformCallback(callback?: Callback, once?: boolean): number;
  unregisterCallback(id: number): void;
};

type NativeWindow = Window & {
  __BUZZ_NATIVE__?: { protocol: string };
  __TAURI_EVENT_PLUGIN_INTERNALS__?: {
    unregisterListener(event: string, id: number): void;
  };
  __TAURI_INTERNALS__?: TauriInternals;
};

type SocketState = {
  channelId: number;
  index: number;
  socket: WebSocket;
};

const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
const nativeWindow = window as NativeWindow;
const bootToken = readBootToken();

if (bootToken && !nativeWindow.__TAURI_INTERNALS__) {
  installTauriCompatibilityLayer(bootToken);
}

function installTauriCompatibilityLayer(token: string): void {
  const callbacks = new Map<number, { callback: Callback; once: boolean }>();
  const eventListeners = new Map<string, Map<number, number>>();
  const sockets = new Map<number, SocketState>();
  let nextCallbackId = 1;
  let nextEventId = 1;
  let nextSocketId = 1;
  let eventPolling = true;
  let voiceInputMode: "push_to_talk" | "voice_activity" = "voice_activity";

  const emitLocalEvent = (event: string, payload: unknown): void => {
    for (const [eventId, callbackId] of eventListeners.get(event) ?? []) {
      runCallback(callbacks, callbackId, { event, id: eventId, payload });
    }
  };
  const huddleTranscription = new HuddleTranscription({
    emit: emitLocalEvent,
    invoke: (command, args) => invokeDesktopHost(command, args, token),
  });
  const huddleAudio = new HuddleAudioTransport({
    emit: emitLocalEvent,
    interruptSpeech: () => {
      speechSynthesis.cancel();
      huddleTranscription.setTtsSpeaking(false);
    },
    invoke: (command, args) => invokeDesktopHost(command, args, token),
  });

  const internals: TauriInternals = {
    metadata: {
      currentWebview: { label: "main", windowLabel: "main" },
      currentWindow: { label: "main" },
    },

    transformCallback(callback = () => undefined, once = false): number {
      const id = nextCallbackId++;
      callbacks.set(id, { callback, once });
      return id;
    },

    unregisterCallback(id: number): void {
      callbacks.delete(id);
    },

    convertFileSrc(filePath: string): string {
      return filePath.startsWith("http:") ||
        filePath.startsWith("https:") ||
        filePath.startsWith("data:")
        ? filePath
        : filePath;
    },

    async invoke(command: string, rawArgs: unknown = {}): Promise<unknown> {
      if (command === "push_audio_pcm") {
        huddleAudio.pushPcm(rawArgs);
        return null;
      }
      const args = requireArguments(rawArgs);
      if (command.startsWith("plugin:websocket|")) {
        return invokeWebSocket(
          command,
          args,
          sockets,
          callbacks,
          () => nextSocketId++,
        );
      }
      if (command.startsWith("plugin:event|")) {
        return invokeEvent(
          command,
          args,
          eventListeners,
          callbacks,
          () => nextEventId++,
        );
      }
      if (command.startsWith("plugin:window|")) {
        return invokeWindow(command, args);
      }
      if (command.startsWith("plugin:webview|")) return null;
      if (command.startsWith("plugin:path|")) return invokePath(command, args);
      if (command.startsWith("plugin:opener|"))
        return invokeOpener(command, args);
      if (command.startsWith("plugin:notification|")) {
        return invokeNotification(command, args);
      }
      if (command.startsWith("plugin:process|")) {
        return invokeProcess(command);
      }
      if (command.startsWith("plugin:updater|")) {
        return command.endsWith("|check") ? null : undefined;
      }
      if (command.startsWith("plugin:app|")) return invokeApp(command);
      if (command === "copy_text_to_clipboard") {
        await navigator.clipboard.writeText(requireText(args.text, "text"));
        return null;
      }
      if (command === "show_native_notification") {
        return showNotification(args);
      }
      if (
        command === "fetch_media_bytes" ||
        command === "fetch_snapshot_bytes"
      ) {
        return invokeBinaryDownload(command, args, token);
      }
      if (command === "upload_media_bytes") {
        return invokeBinaryUpload(args, token);
      }
      if (
        command === "preview_agent_snapshot_import" ||
        command === "confirm_agent_snapshot_import" ||
        command === "preview_team_snapshot_import" ||
        command === "confirm_team_snapshot_import"
      ) {
        return invokeSnapshotCommand(command, args, token);
      }
      if (command === "confirm_huddle_active") {
        const config = await invokeDesktopHost(
          "get_huddle_audio_config",
          {},
          token,
        );
        await huddleAudio.connect(config);
        try {
          return await invokeDesktopHost(command, args, token);
        } catch (error) {
          await huddleAudio.disconnect();
          throw error;
        }
      }
      if (command === "reconnect_huddle_audio") {
        const config = await invokeDesktopHost(command, args, token);
        await huddleAudio.reconnect(config);
        return null;
      }
      if (command === "leave_huddle" || command === "end_huddle") {
        await huddleAudio.disconnect();
        huddleTranscription.stop();
        speechSynthesis.cancel();
        return invokeDesktopHost(command, args, token);
      }
      if (command === "list_audio_output_devices") {
        return listAudioOutputDevices();
      }
      if (command === "set_audio_output_device") {
        await setAudioOutputDevice(args.name);
        await huddleAudio.setOutputDevice();
        return null;
      }
      if (command === "get_audio_output_device") {
        return localStorage.getItem("buzz.huddle.output-device-name") ?? "";
      }
      if (command === "set_voice_input_mode") {
        const mode = requireVoiceInputMode(args.mode);
        const result = await invokeDesktopHost(command, args, token);
        voiceInputMode = mode;
        huddleTranscription.setVoiceMode(mode);
        if (mode === "voice_activity") emitLocalEvent("ptt-state", false);
        return result;
      }
      if (command === "get_voice_input_mode") {
        const result = await invokeDesktopHost(command, args, token);
        voiceInputMode = requireVoiceInputMode(result);
        return voiceInputMode;
      }
      if (command === "set_tts_enabled") {
        const result = await invokeDesktopHost(command, args, token);
        if (args.enabled === false) speechSynthesis.cancel();
        return result;
      }
      if (command === "set_huddle_transcription_enabled") {
        const enabled = args.enabled === true;
        if (args.enabled !== true && args.enabled !== false) {
          throw new Error("enabled must be a boolean");
        }
        if (enabled && !huddleTranscription.available()) {
          throw new Error(
            "Live transcription is unavailable in this browser. Use current Chromium.",
          );
        }
        const result = await invokeDesktopHost(command, args, token);
        try {
          huddleTranscription.setEnabled(enabled);
        } catch (error) {
          if (enabled) {
            await invokeDesktopHost(command, { enabled: false }, token).catch(
              () => undefined,
            );
          }
          throw error;
        }
        return result;
      }
      if (command === "speak_agent_message") {
        return speakAgentMessage(args, token, huddleTranscription);
      }
      if (command === "get_model_status") {
        return {
          stt: huddleTranscription.available() ? "ready" : "unavailable",
          tts: "speechSynthesis" in window ? "ready" : "unavailable",
        };
      }

      return invokeDesktopHost(command, args, token);
    },
  };

  nativeWindow.__TAURI_INTERNALS__ = internals;
  nativeWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      eventListeners.get(event)?.delete(id);
    },
  };
  nativeWindow.__BUZZ_NATIVE__ = { protocol: "buzz.desktop.ipc.v1" };
  void pollDesktopEvents(
    token,
    eventListeners,
    callbacks,
    () => eventPolling,
    (entry) => {
      if (
        entry.event === "huddle-speak-request" &&
        typeof entry.payload === "object" &&
        entry.payload !== null &&
        "text" in entry.payload
      ) {
        void speakAgentMessage(
          { text: entry.payload.text },
          token,
          huddleTranscription,
        ).catch(() => undefined);
      }
    },
  );

  window.addEventListener("beforeunload", () => {
    eventPolling = false;
    for (const state of sockets.values())
      state.socket.close(1000, "page unload");
    sockets.clear();
    callbacks.clear();
    eventListeners.clear();
    void huddleAudio.disconnect();
    huddleTranscription.stop();
  });

  let pttPressed = false;
  const releasePtt = () => {
    if (!pttPressed) return;
    pttPressed = false;
    huddleTranscription.setPttActive(false);
    emitLocalEvent("ptt-state", false);
  };
  window.addEventListener("keydown", (event) => {
    if (
      voiceInputMode !== "push_to_talk" ||
      event.repeat ||
      event.code !== "Space" ||
      !event.ctrlKey
    ) {
      return;
    }
    event.preventDefault();
    pttPressed = true;
    huddleTranscription.setPttActive(true);
    speechSynthesis.cancel();
    emitLocalEvent("ptt-state", true);
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.key === "Control") releasePtt();
  });
  window.addEventListener("blur", releasePtt);
}

async function invokeDesktopHost(
  command: string,
  args: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const response = await fetch("/api/invoke", {
    body: JSON.stringify({ args, command }),
    headers: {
      "Content-Type": "application/json",
      "X-Buzz-Desktop-Token": token,
    },
    method: "POST",
  });
  const payload = (await response.json()) as {
    error?: unknown;
    ok?: unknown;
    result?: unknown;
  };
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `desktop command failed (${response.status})`,
    );
  }
  return payload.result;
}

function requireArguments(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new Error("desktop command arguments must be an object");
  }
  return value as Record<string, unknown>;
}

async function listAudioOutputDevices(): Promise<
  Array<{ is_default: boolean; name: string }>
> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audiooutput",
  );
  return devices.map((device, index) => ({
    is_default: device.deviceId === "default",
    name:
      device.label ||
      (device.deviceId === "default"
        ? "System default"
        : `Speaker ${index + 1}`),
  }));
}

async function setAudioOutputDevice(value: unknown): Promise<void> {
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("audio output device name must be a bounded string");
  }
  if (!value) {
    localStorage.removeItem("buzz.huddle.output-device-id");
    localStorage.removeItem("buzz.huddle.output-device-name");
    return;
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audiooutput",
  );
  const match = devices.find(
    (device, index) =>
      (device.label ||
        (device.deviceId === "default"
          ? "System default"
          : `Speaker ${index + 1}`)) === value,
  );
  if (!match) throw new Error("selected audio output device is unavailable");
  localStorage.setItem("buzz.huddle.output-device-id", match.deviceId);
  localStorage.setItem("buzz.huddle.output-device-name", value);
}

function requireVoiceInputMode(
  value: unknown,
): "push_to_talk" | "voice_activity" {
  if (value !== "push_to_talk" && value !== "voice_activity") {
    throw new Error("invalid voice input mode");
  }
  return value;
}

async function speakAgentMessage(
  args: Record<string, unknown>,
  token: string,
  transcription: HuddleTranscription,
): Promise<null> {
  if (!("speechSynthesis" in window)) return null;
  const text = requireText(args.text, "text").trim();
  if (!text) return null;
  const state = await invokeDesktopHost("get_huddle_state", {}, token);
  if (
    typeof state !== "object" ||
    state === null ||
    !("phase" in state) ||
    (state.phase !== "connected" && state.phase !== "active") ||
    !("tts_enabled" in state) ||
    state.tts_enabled !== true
  ) {
    return null;
  }
  const bounded = [...text].slice(0, 2_000).join("");
  const utterance = new SpeechSynthesisUtterance(
    bounded.length < [...text].length
      ? `${bounded}... message truncated.`
      : bounded,
  );
  utterance.rate = 1;
  utterance.pitch = 1;
  const resumeTranscription = () => transcription.setTtsSpeaking(false);
  utterance.onend = resumeTranscription;
  utterance.onerror = resumeTranscription;
  transcription.setTtsSpeaking(true);
  try {
    speechSynthesis.speak(utterance);
  } catch (error) {
    resumeTranscription();
    throw error;
  }
  return null;
}

async function pollDesktopEvents(
  token: string,
  listeners: Map<string, Map<number, number>>,
  callbacks: Map<number, { callback: Callback; once: boolean }>,
  isActive: () => boolean,
  onEvent?: (entry: { event: string; id: number; payload: unknown }) => void,
): Promise<void> {
  let cursor = 0;
  while (isActive()) {
    try {
      const result = await invokeDesktopHost(
        "poll_desktop_events",
        { afterId: cursor },
        token,
      );
      if (isEventBatch(result, cursor)) {
        cursor = result.cursor;
        for (const entry of result.events) {
          try {
            onEvent?.(entry);
          } catch {
            // Internal event observers are isolated from app event delivery.
          }
          for (const [eventId, callbackId] of listeners.get(entry.event) ??
            []) {
            try {
              runCallback(callbacks, callbackId, {
                event: entry.event,
                id: eventId,
                payload: entry.payload,
              });
            } catch {
              // A renderer listener cannot break delivery to other listeners.
            }
          }
        }
      }
    } catch {
      // A brief host restart or network interruption is recoverable. The
      // monotonic cursor prevents duplicate delivery after polling resumes.
    }
    if (isActive()) await delay(200);
  }
}

function isEventBatch(
  value: unknown,
  minimumCursor: number,
): value is {
  cursor: number;
  events: Array<{ event: string; id: number; payload: unknown }>;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("cursor" in value) ||
    typeof value.cursor !== "number" ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < minimumCursor ||
    !("events" in value) ||
    !Array.isArray(value.events)
  ) {
    return false;
  }
  const cursor = value.cursor;
  return value.events.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "event" in entry &&
      typeof entry.event === "string" &&
      /^[A-Za-z0-9_:/-]{1,128}$/.test(entry.event) &&
      "id" in entry &&
      typeof entry.id === "number" &&
      Number.isSafeInteger(entry.id) &&
      entry.id > minimumCursor &&
      entry.id <= cursor &&
      "payload" in entry,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function invokeBinaryDownload(
  command: "fetch_media_bytes" | "fetch_snapshot_bytes",
  args: Record<string, unknown>,
  token: string,
): Promise<ArrayBuffer> {
  const response = await fetch("/api/binary/invoke", {
    body: JSON.stringify({ args, command }),
    headers: {
      "Content-Type": "application/json",
      "X-Buzz-Desktop-Token": token,
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await desktopError(response, "binary fetch failed"));
  }
  return response.arrayBuffer();
}

async function invokeBinaryUpload(
  args: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const data = requireByteArray(args.data, 100 * 1024 * 1024);
  const metadata = {
    ...(args.filename === undefined || args.filename === null
      ? {}
      : { filename: requireText(args.filename, "filename") }),
    ...(args.progressId === undefined || args.progressId === null
      ? {}
      : { progressId: requireText(args.progressId, "progressId") }),
  };
  const response = await fetch("/api/binary/upload", {
    body: data,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Buzz-Desktop-Token": token,
      "X-Buzz-Media-Metadata": base64UrlJson(metadata),
    },
    method: "POST",
  });
  const payload = (await response.json()) as {
    error?: unknown;
    ok?: unknown;
    result?: unknown;
  };
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "binary upload failed",
    );
  }
  return payload.result;
}

async function invokeSnapshotCommand(
  command:
    | "preview_agent_snapshot_import"
    | "confirm_agent_snapshot_import"
    | "preview_team_snapshot_import"
    | "confirm_team_snapshot_import",
  args: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const preview = command.startsWith("preview_");
  let fileBytes: Uint8Array<ArrayBuffer>;
  let metadata: Record<string, unknown>;
  if (preview) {
    fileBytes = requireByteArray(args.fileBytes, 50 * 1024 * 1024);
    metadata = {
      command,
      fileName: requireText(args.fileName, "fileName"),
    };
  } else {
    if (
      typeof args.input !== "object" ||
      args.input === null ||
      Array.isArray(args.input)
    ) {
      throw new Error("snapshot input must be an object");
    }
    const input = args.input as Record<string, unknown>;
    fileBytes = requireByteArray(input.fileBytes, 50 * 1024 * 1024);
    if (typeof input.keepAllowlist !== "boolean") {
      throw new Error("keepAllowlist must be a boolean");
    }
    metadata = { command, keepAllowlist: input.keepAllowlist };
  }
  const response = await fetch("/api/binary/snapshot", {
    body: fileBytes,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Buzz-Desktop-Token": token,
      "X-Buzz-Snapshot-Metadata": base64UrlJson(metadata),
    },
    method: "POST",
  });
  const payload = (await response.json()) as {
    error?: unknown;
    ok?: unknown;
    result?: unknown;
  };
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "snapshot command failed",
    );
  }
  return payload.result;
}

async function desktopError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : fallback;
  } catch {
    return fallback;
  }
}

function requireByteArray(
  value: unknown,
  maximum: number,
): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > maximum) {
      throw new Error("upload byte length is invalid");
    }
    return Uint8Array.from(value);
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error("data must be a bounded byte array");
  }
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error("data contains an invalid byte");
    }
    output[index] = byte;
  }
  return output;
}

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function invokeWebSocket(
  command: string,
  args: Record<string, unknown>,
  sockets: Map<number, SocketState>,
  callbacks: Map<number, { callback: Callback; once: boolean }>,
  allocateSocketId: () => number,
): Promise<unknown> {
  const operation = command.slice("plugin:websocket|".length);
  if (operation === "connect") {
    const url = requireText(args.url, "url");
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("relay websocket URL must use ws: or wss:");
    }
    const channelId = readChannelId(args.onMessage);
    const id = allocateSocketId();
    const socket = new WebSocket(parsed.toString());
    const state: SocketState = { channelId, index: 0, socket };
    sockets.set(id, state);
    socket.addEventListener("open", () =>
      emitChannel(callbacks, state, { type: "Open" }),
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        emitChannel(callbacks, state, { data: event.data, type: "Text" });
      } else {
        void toUint8Array(event.data).then((data) => {
          emitChannel(callbacks, state, { data: [...data], type: "Binary" });
        });
      }
    });
    socket.addEventListener("error", () => {
      emitChannel(callbacks, state, {
        data: "websocket transport error",
        type: "Error",
      });
    });
    socket.addEventListener("close", (event) => {
      emitChannel(callbacks, state, {
        data: { code: event.code, reason: event.reason },
        type: "Close",
      });
      callbacks.get(channelId)?.callback({ end: true, index: state.index });
      callbacks.delete(channelId);
      sockets.delete(id);
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.close(1000, "connection timeout");
        reject(new Error("websocket connection timed out"));
      }, WEBSOCKET_CONNECT_TIMEOUT_MS);
      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          window.clearTimeout(timeout);
          reject(new Error("websocket closed before it opened"));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timeout);
          reject(new Error("websocket failed to connect"));
        },
        { once: true },
      );
    });
    return id;
  }

  if (operation === "send") {
    const state = requireSocket(sockets, args.id);
    if (state.socket.readyState !== WebSocket.OPEN) {
      throw new Error("websocket is not open");
    }
    const message = args.message;
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message)
    ) {
      throw new Error("websocket message has an invalid shape");
    }
    if (message.type === "Text" && "data" in message) {
      state.socket.send(requireText(message.data, "message.data"));
    } else if (message.type === "Binary" && "data" in message) {
      if (!Array.isArray(message.data)) {
        throw new Error("binary websocket data must be an array");
      }
      state.socket.send(new Uint8Array(message.data as number[]));
    } else if (message.type === "Ping" || message.type === "Pong") {
      throw new Error("browser WebSocket does not expose ping or pong frames");
    } else {
      throw new Error(
        `unsupported websocket message type: ${String(message.type)}`,
      );
    }
    return null;
  }

  if (operation === "disconnect") {
    const state = requireSocket(sockets, args.id);
    state.socket.close(1000, "client disconnect");
    return null;
  }
  if (operation === "disconnect_all") {
    for (const state of sockets.values())
      state.socket.close(1000, "client disconnect");
    return null;
  }
  throw new Error(`unsupported websocket operation: ${operation}`);
}

function invokeEvent(
  command: string,
  args: Record<string, unknown>,
  listeners: Map<string, Map<number, number>>,
  callbacks: Map<number, { callback: Callback; once: boolean }>,
  allocateEventId: () => number,
): unknown {
  const operation = command.slice("plugin:event|".length);
  const event = requireText(args.event, "event");
  if (!/^[A-Za-z0-9_:/-]+$/.test(event)) {
    throw new Error("event name contains forbidden characters");
  }
  if (operation === "listen") {
    const callbackId = readCallbackId(args.handler);
    const eventId = allocateEventId();
    const forEvent = listeners.get(event) ?? new Map<number, number>();
    forEvent.set(eventId, callbackId);
    listeners.set(event, forEvent);
    return eventId;
  }
  if (operation === "unlisten") {
    const eventId = requireInteger(args.eventId, "eventId");
    listeners.get(event)?.delete(eventId);
    return null;
  }
  if (operation === "emit" || operation === "emit_to") {
    for (const [eventId, callbackId] of listeners.get(event) ?? []) {
      runCallback(callbacks, callbackId, {
        event,
        id: eventId,
        payload: args.payload ?? null,
      });
    }
    return null;
  }
  throw new Error(`unsupported event operation: ${operation}`);
}

async function invokeWindow(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const operation = command.slice("plugin:window|".length);
  switch (operation) {
    case "get_all_windows":
      return ["main"];
    case "is_fullscreen":
      return document.fullscreenElement !== null;
    case "is_focused":
      return document.hasFocus();
    case "is_maximized":
    case "is_minimized":
    case "is_always_on_top":
      return false;
    case "is_closable":
    case "is_decorated":
    case "is_enabled":
    case "is_maximizable":
    case "is_minimizable":
    case "is_resizable":
    case "is_visible":
      return true;
    case "scale_factor":
      return window.devicePixelRatio;
    case "inner_size":
    case "outer_size":
      return { height: window.innerHeight, width: window.innerWidth };
    case "inner_position":
    case "outer_position":
      return { x: window.screenX, y: window.screenY };
    case "title":
      return document.title;
    case "theme":
      return matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    case "set_title":
      document.title = requireText(args.title, "title");
      return null;
    case "set_fullscreen":
      if (args.fullscreen === true)
        await document.documentElement.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
      return null;
    case "close":
    case "destroy":
      window.close();
      return null;
    case "set_focus":
      window.focus();
      return null;
    case "request_user_attention":
      return null;
    default:
      return null;
  }
}

function invokePath(command: string, args: Record<string, unknown>): unknown {
  const operation = command.slice("plugin:path|".length);
  const paths = Array.isArray(args.paths)
    ? args.paths.map((part) => requireText(part, "path"))
    : [];
  switch (operation) {
    case "join":
    case "resolve":
      return normalizePath(paths.join("/"));
    case "normalize":
      return normalizePath(requireText(args.path, "path"));
    case "dirname": {
      const value = normalizePath(requireText(args.path, "path"));
      return value.slice(0, value.lastIndexOf("/")) || "/";
    }
    case "basename": {
      const value = normalizePath(requireText(args.path, "path"));
      return value.slice(value.lastIndexOf("/") + 1);
    }
    case "extname": {
      const basename = String(invokePath("plugin:path|basename", args));
      const index = basename.lastIndexOf(".");
      return index > 0 ? basename.slice(index) : "";
    }
    case "is_absolute":
      return requireText(args.path, "path").startsWith("/");
    case "resolve_directory":
      return "/";
    default:
      throw new Error(`unsupported path operation: ${operation}`);
  }
}

function invokeOpener(command: string, args: Record<string, unknown>): null {
  const operation = command.slice("plugin:opener|".length);
  if (operation === "open_url") {
    const url = requireText(args.url, "url");
    const parsed = new URL(url);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      throw new Error("external URL uses a forbidden scheme");
    }
    window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    return null;
  }
  throw new Error(`${operation} requires the packaged filesystem host`);
}

async function invokeNotification(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const operation = command.slice("plugin:notification|".length);
  if (operation === "is_permission_granted") {
    return "Notification" in window && Notification.permission === "granted";
  }
  if (operation === "request_permission") {
    return "Notification" in window
      ? Notification.requestPermission()
      : "denied";
  }
  if (operation === "notify") {
    await showNotification(args.options as Record<string, unknown>);
    return null;
  }
  return null;
}

function invokeProcess(command: string): null {
  const operation = command.slice("plugin:process|".length);
  if (operation === "restart") location.reload();
  if (operation === "exit") window.close();
  return null;
}

function invokeApp(command: string): unknown {
  const operation = command.slice("plugin:app|".length);
  if (operation === "version") return "0.4.26-ts";
  if (operation === "name") return "Buzz";
  if (operation === "tauri_version") return "typescript-host";
  if (operation === "identifier") return "com.buzz.desktop.typescript";
  return null;
}

async function showNotification(args: Record<string, unknown>): Promise<null> {
  if (!("Notification" in window)) return null;
  if (Notification.permission === "default")
    await Notification.requestPermission();
  if (Notification.permission !== "granted") return null;
  const title =
    typeof args.title === "string" && args.title.length > 0
      ? args.title
      : "Buzz";
  const body = typeof args.body === "string" ? args.body : undefined;
  new Notification(title, { body });
  return null;
}

function emitChannel(
  callbacks: Map<number, { callback: Callback; once: boolean }>,
  state: SocketState,
  message: unknown,
): void {
  const callback = callbacks.get(state.channelId);
  callback?.callback({ index: state.index++, message });
}

function runCallback(
  callbacks: Map<number, { callback: Callback; once: boolean }>,
  id: number,
  value: unknown,
): void {
  const entry = callbacks.get(id);
  if (!entry) return;
  entry.callback(value);
  if (entry.once) callbacks.delete(id);
}

function readChannelId(value: unknown): number {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    throw new Error("websocket callback channel is missing");
  }
  return requireInteger(value.id, "channel.id");
}

function readCallbackId(value: unknown): number {
  return requireInteger(value, "callback id");
}

function requireSocket(
  sockets: Map<number, SocketState>,
  value: unknown,
): SocketState {
  const id = requireInteger(value, "websocket id");
  const state = sockets.get(id);
  if (!state) throw new Error(`unknown websocket id ${id}`);
  return state;
}

function requireInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function normalizePath(value: string): string {
  const absolute = value.startsWith("/");
  const output: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return `${absolute ? "/" : ""}${output.join("/")}` || (absolute ? "/" : ".");
}

async function toUint8Array(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error("unsupported browser websocket binary frame");
}

function readBootToken(): string | null {
  const sessionKey = "buzz.desktop.boot-token.v1";
  if (location.hash.startsWith("#buzz-token=")) {
    const token = decodeURIComponent(
      location.hash.slice("#buzz-token=".length),
    );
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return null;
    sessionStorage.setItem(sessionKey, token);
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}`,
    );
    return token;
  }
  const retained = sessionStorage.getItem(sessionKey);
  return retained && /^[A-Za-z0-9_-]{43,128}$/.test(retained) ? retained : null;
}

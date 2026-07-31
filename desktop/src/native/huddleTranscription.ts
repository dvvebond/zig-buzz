type HostInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

type LocalEmit = (event: string, payload: unknown) => void;

type RecognitionAlternative = {
  transcript: string;
};

type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
};

type RecognitionEvent = Event & {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResult;
  };
};

type RecognitionErrorEvent = Event & {
  readonly error?: string;
  readonly message?: string;
};

type BrowserRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
};

type RecognitionConstructor = new () => BrowserRecognition;

/**
 * Opt-in browser speech transcription.
 *
 * Every final segment is re-authorized against the host's current huddle
 * generation before it is posted. PTT mode runs recognition only while the
 * key is held. Fatal permission/service errors turn the host flag back off.
 */
export class HuddleTranscription {
  readonly #emit: LocalEmit;
  readonly #invoke: HostInvoke;
  #desired = false;
  #generation = 0;
  #postChain: Promise<void> = Promise.resolve();
  #pttActive = false;
  #recognition: BrowserRecognition | null = null;
  #restartTimer = 0;
  #ttsSpeaking = false;
  #voiceMode: "push_to_talk" | "voice_activity" = "voice_activity";

  constructor(input: { emit: LocalEmit; invoke: HostInvoke }) {
    this.#emit = input.emit;
    this.#invoke = input.invoke;
  }

  available(): boolean {
    return recognitionConstructor() !== null;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.available()) {
      throw new Error(
        "Live transcription is unavailable in this browser. Use current Chromium.",
      );
    }
    this.#desired = enabled;
    ++this.#generation;
    this.#sync();
  }

  setVoiceMode(mode: "push_to_talk" | "voice_activity"): void {
    this.#voiceMode = mode;
    this.#sync();
  }

  setPttActive(active: boolean): void {
    this.#pttActive = active;
    this.#sync();
  }

  setTtsSpeaking(active: boolean): void {
    this.#ttsSpeaking = active;
    this.#sync();
  }

  stop(): void {
    this.#desired = false;
    ++this.#generation;
    this.#sync();
  }

  #shouldRun(): boolean {
    return (
      this.#desired &&
      !this.#ttsSpeaking &&
      (this.#voiceMode === "voice_activity" || this.#pttActive)
    );
  }

  #sync(): void {
    if (this.#shouldRun()) {
      this.#start();
    } else {
      this.#stopRecognition();
    }
  }

  #start(): void {
    if (this.#recognition || this.#restartTimer) return;
    const Constructor = recognitionConstructor();
    if (!Constructor) return;
    const generation = this.#generation;
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      if (generation !== this.#generation || !this.#shouldRun()) return;
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim();
        if (result?.isFinal && transcript) this.#enqueueTranscript(transcript);
      }
    };
    recognition.onerror = (event) => {
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "audio-capture"
      ) {
        this.#desired = false;
        ++this.#generation;
        void this.#invoke("set_huddle_transcription_enabled", {
          enabled: false,
        }).catch(() => undefined);
        this.#emit(
          "huddle-transcription-error",
          event.message || event.error || "transcription unavailable",
        );
      }
    };
    recognition.onend = () => {
      if (this.#recognition === recognition) this.#recognition = null;
      if (
        generation === this.#generation &&
        this.#shouldRun() &&
        !this.#restartTimer
      ) {
        this.#restartTimer = window.setTimeout(() => {
          this.#restartTimer = 0;
          this.#start();
        }, 250);
      }
    };
    this.#recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      this.#recognition = null;
      throw error;
    }
  }

  #stopRecognition(): void {
    if (this.#restartTimer) window.clearTimeout(this.#restartTimer);
    this.#restartTimer = 0;
    const recognition = this.#recognition;
    this.#recognition = null;
    if (recognition) {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.stop();
      } catch {
        // Already stopped by the browser.
      }
    }
  }

  #enqueueTranscript(content: string): void {
    const bounded = [...content].slice(0, 16_000).join("");
    const generation = this.#generation;
    this.#postChain = this.#postChain
      .then(async () => {
        if (generation !== this.#generation || !this.#desired) return;
        const state = parseHuddleState(
          await this.#invoke("get_huddle_state", {}),
        );
        if (
          !state.transcription_enabled ||
          (state.phase !== "connected" && state.phase !== "active") ||
          generation !== this.#generation
        ) {
          return;
        }
        const agents = await this.#invoke("get_huddle_agent_pubkeys", {});
        const mentionPubkeys = parsePubkeys(agents);
        await this.#invoke("send_channel_message", {
          channelId: state.ephemeral_channel_id,
          content: bounded,
          mentionPubkeys,
        });
      })
      .catch((error) => {
        this.#emit(
          "huddle-transcription-error",
          error instanceof Error ? error.message : "transcript post failed",
        );
      });
  }
}

function recognitionConstructor(): RecognitionConstructor | null {
  const speechWindow = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return (
    speechWindow.SpeechRecognition ??
    speechWindow.webkitSpeechRecognition ??
    null
  );
}

function parseHuddleState(value: unknown): {
  ephemeral_channel_id: string;
  phase: string;
  transcription_enabled: boolean;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("host returned an invalid huddle state");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.ephemeral_channel_id !== "string" ||
    typeof input.phase !== "string" ||
    typeof input.transcription_enabled !== "boolean"
  ) {
    throw new Error("host returned an incomplete huddle state");
  }
  return {
    ephemeral_channel_id: input.ephemeral_channel_id,
    phase: input.phase,
    transcription_enabled: input.transcription_enabled,
  };
}

function parsePubkeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    !value.every(
      (entry) => typeof entry === "string" && /^[0-9a-f]{64}$/.test(entry),
    )
  ) {
    throw new Error("host returned an invalid huddle agent list");
  }
  return [...new Set(value)];
}

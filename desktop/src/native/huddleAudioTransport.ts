type HostInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

type LocalEmit = (event: string, payload: unknown) => void;

type AudioConfig = {
  audio_url: string;
  ephemeral_channel_id: string;
  parent_channel_id: string;
  relay_url: string;
};

type Peer = {
  peer_index: number;
  pubkey: string;
};

type DecoderState = {
  decoder: AudioDecoder;
  nextTime: number;
};

const FRAME_SAMPLES = 960;
const SAMPLE_RATE = 48_000;
const HEADER_BYTES = 8;
const MAX_AUDIO_FRAME_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const SPEAKER_HOLD_MS = 800;
const SPEAKER_THRESHOLD_DBOV = -55;

/**
 * Huddle audio protocol v2.
 *
 * The trusted host supplies a signed NIP-42 event. This class holds no Nostr
 * secret. It exchanges one outbound WebSocket with the relay, encodes 20 ms
 * mono frames with WebCodecs Opus, and plays independently decoded peer streams
 * through a bounded browser jitter queue.
 */
export class HuddleAudioTransport {
  readonly #emit: LocalEmit;
  readonly #interruptSpeech: () => void;
  readonly #invoke: HostInvoke;
  #audioContext: AudioContext | null = null;
  #config: AudioConfig | null = null;
  #connectGeneration = 0;
  #decoders = new Map<number, DecoderState>();
  #encoder: AudioEncoder | null = null;
  #levels: number[] = [];
  #peerPubkeys = new Map<number, string>();
  #outputTimestamp48k = 0;
  #sequence = 0;
  #socket: WebSocket | null = null;
  #speakerTimer = 0;
  #speakers = new Map<string, number>();
  #timestamp48k = 0;
  #intentionalClose = true;

  constructor(input: {
    emit: LocalEmit;
    interruptSpeech?: () => void;
    invoke: HostInvoke;
  }) {
    this.#emit = input.emit;
    this.#interruptSpeech =
      input.interruptSpeech ?? (() => speechSynthesis.cancel());
    this.#invoke = input.invoke;
  }

  async connect(configValue: unknown): Promise<void> {
    const config = parseAudioConfig(configValue);
    await this.disconnect();
    requireWebCodecs();
    const generation = ++this.#connectGeneration;
    this.#config = config;
    this.#intentionalClose = false;
    this.#audioContext = new AudioContext({
      latencyHint: "interactive",
      sampleRate: SAMPLE_RATE,
    });
    if (this.#audioContext.state === "suspended") {
      await this.#audioContext.resume();
    }
    await this.#applyOutputDevice();
    this.#encoder = this.#createEncoder(generation);

    const socket = new WebSocket(config.audio_url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    try {
      await this.#performHandshake(socket, config, generation);
    } catch (error) {
      this.#intentionalClose = true;
      socket.close(1000, "handshake failed");
      await this.#disposeMedia();
      throw error;
    }
    if (generation !== this.#connectGeneration) {
      throw new Error("huddle audio connection was superseded");
    }
    socket.addEventListener("message", (event) => {
      void this.#onMessage(event, generation);
    });
    socket.addEventListener("close", () => {
      void this.#onClose(generation);
    });
    socket.addEventListener("error", () => {
      // The close event owns reconnect signaling so one failure yields one event.
    });
    this.#speakerTimer = window.setInterval(
      () => this.#emitActiveSpeakers(),
      200,
    );
  }

  async reconnect(configValue: unknown): Promise<void> {
    await this.connect(configValue);
  }

  pushPcm(value: unknown): void {
    const bytes = requirePcm(value);
    const encoder = this.#encoder;
    const socket = this.#socket;
    if (
      !encoder ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      encoder.state !== "configured"
    ) {
      return;
    }
    if (encoder.encodeQueueSize >= 8 || this.#levels.length >= 16) {
      return;
    }
    const copied = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(copied.buffer).set(bytes);
    for (let offset = 0; offset < copied.length; offset += FRAME_SAMPLES) {
      if (encoder.encodeQueueSize >= 8 || this.#levels.length >= 16) break;
      const frame = new Float32Array(FRAME_SAMPLES);
      frame.set(copied.subarray(offset, offset + FRAME_SAMPLES));
      this.#levels.push(audioLevelDbov(frame));
      const audio = new AudioData({
        data: frame,
        format: "f32",
        numberOfChannels: 1,
        numberOfFrames: FRAME_SAMPLES,
        sampleRate: SAMPLE_RATE,
        timestamp: Math.round((this.#timestamp48k * 1_000_000) / SAMPLE_RATE),
      });
      this.#timestamp48k = (this.#timestamp48k + FRAME_SAMPLES) >>> 0;
      try {
        encoder.encode(audio);
      } finally {
        audio.close();
      }
    }
  }

  async setOutputDevice(): Promise<void> {
    await this.#applyOutputDevice();
  }

  async disconnect(): Promise<void> {
    ++this.#connectGeneration;
    this.#intentionalClose = true;
    const socket = this.#socket;
    this.#socket = null;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, "client leave");
    }
    await this.#disposeMedia();
    this.#config = null;
  }

  #createEncoder(generation: number): AudioEncoder {
    const encoder = new AudioEncoder({
      error: () => {
        if (generation === this.#connectGeneration) {
          this.#levels.length = 0;
        }
      },
      output: (chunk) => {
        if (generation !== this.#connectGeneration) return;
        const socket = this.#socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (chunk.byteLength < 1 || chunk.byteLength > MAX_AUDIO_FRAME_BYTES) {
          return;
        }
        const opus = new Uint8Array(chunk.byteLength);
        chunk.copyTo(opus);
        const level = this.#levels.shift() ?? -127;
        const frame = new Uint8Array(HEADER_BYTES + opus.byteLength);
        const view = new DataView(frame.buffer);
        view.setUint16(0, this.#sequence, false);
        view.setUint32(2, this.#outputTimestamp48k, false);
        view.setInt8(6, level);
        view.setUint8(7, opus.byteLength <= 2 ? 1 : 0);
        frame.set(opus, HEADER_BYTES);
        this.#sequence = (this.#sequence + 1) & 0xffff;
        this.#outputTimestamp48k =
          (this.#outputTimestamp48k + FRAME_SAMPLES) >>> 0;
        socket.send(frame);
      },
    });
    encoder.configure({
      bitrate: 32_000,
      codec: "opus",
      numberOfChannels: 1,
      sampleRate: SAMPLE_RATE,
    });
    return encoder;
  }

  async #performHandshake(
    socket: WebSocket,
    config: AudioConfig,
    generation: number,
  ): Promise<void> {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
          resolve();
        };
        const onError = () => reject(new Error("audio WebSocket failed"));
        const onClose = () =>
          reject(new Error("audio WebSocket closed before authentication"));
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.addEventListener("close", onClose, { once: true });
      }),
      HANDSHAKE_TIMEOUT_MS,
      "timeout connecting to huddle audio relay",
    );

    const challenge = await withTimeout(
      waitForText(socket, (message) => {
        const parsed = parseControl(message);
        if (parsed.type !== "challenge") return undefined;
        if (
          typeof parsed.challenge !== "string" ||
          parsed.challenge.length < 1 ||
          parsed.challenge.length > 4_096
        ) {
          throw new Error("audio relay sent an invalid challenge");
        }
        return parsed.challenge;
      }),
      HANDSHAKE_TIMEOUT_MS,
      "timeout waiting for huddle audio challenge",
    );
    if (generation !== this.#connectGeneration) {
      throw new Error("huddle audio connection was superseded");
    }
    const signed = await this.#invoke("create_auth_event", {
      challenge,
      relayUrl: config.relay_url,
    });
    if (typeof signed !== "string" || signed.length > 64 * 1024) {
      throw new Error("host returned an invalid audio authorization event");
    }
    let event: unknown;
    try {
      event = JSON.parse(signed);
    } catch {
      throw new Error("host returned malformed audio authorization JSON");
    }
    socket.send(
      JSON.stringify({
        event,
        parent_channel_id: config.parent_channel_id,
        protocol_version: 2,
        type: "auth",
      }),
    );

    const peers = await withTimeout(
      waitForText(socket, (message) => {
        const parsed = parseControl(message);
        if (parsed.type === "error") {
          const detail =
            typeof parsed.message === "string"
              ? parsed.message.slice(0, 1_024)
              : "authorization rejected";
          throw new Error(`audio relay auth error: ${detail}`);
        }
        if (parsed.type !== "joined") return undefined;
        return parsePeers(parsed.peers);
      }),
      HANDSHAKE_TIMEOUT_MS,
      "timeout waiting for huddle audio admission",
    );
    this.#replacePeers(peers);
  }

  async #onMessage(event: MessageEvent, generation: number): Promise<void> {
    if (generation !== this.#connectGeneration) return;
    if (typeof event.data === "string") {
      const control = parseControl(event.data);
      if (control.type === "joined") {
        if (Array.isArray(control.peers)) {
          this.#replacePeers(parsePeers(control.peers));
        } else {
          const peer = parsePeer(control);
          if (peer) this.#peerPubkeys.set(peer.peer_index, peer.pubkey);
          this.#syncRoster();
        }
      } else if (control.type === "left") {
        const peer = parsePeer(control);
        if (peer) {
          this.#peerPubkeys.delete(peer.peer_index);
          this.#closeDecoder(peer.peer_index);
          this.#speakers.delete(peer.pubkey);
          this.#syncRoster();
          this.#emitActiveSpeakers();
        }
      } else if (control.type === "error") {
        this.#socket?.close(1011, "relay error");
      }
      return;
    }
    const frame = await toBytes(event.data);
    this.#decodeFrame(frame);
  }

  #decodeFrame(frame: Uint8Array): void {
    if (frame.byteLength <= 1 + HEADER_BYTES || frame.byteLength > 64 * 1024) {
      return;
    }
    const peerIndex = frame[0];
    const view = new DataView(frame.buffer, frame.byteOffset + 1, HEADER_BYTES);
    const timestamp = view.getUint32(2, false);
    const rawLevel = view.getInt8(6);
    const level = rawLevel >= -127 && rawLevel <= 0 ? rawLevel : -127;
    const dtx = (view.getUint8(7) & 1) !== 0;
    const pubkey = this.#peerPubkeys.get(peerIndex);
    if (pubkey && !dtx && level > SPEAKER_THRESHOLD_DBOV) {
      this.#speakers.set(pubkey, performance.now());
      if (speechSynthesis.speaking) this.#interruptSpeech();
    }
    const opus = frame.subarray(1 + HEADER_BYTES);
    const decoder = this.#decoder(peerIndex);
    if (!decoder || decoder.decoder.decodeQueueSize >= 12) return;
    try {
      decoder.decoder.decode(
        new EncodedAudioChunk({
          data: opus,
          timestamp: Math.round((timestamp * 1_000_000) / SAMPLE_RATE),
          type: "key",
        }),
      );
    } catch {
      // A malformed peer packet cannot terminate other peers' playback.
    }
  }

  #decoder(peerIndex: number): DecoderState | null {
    const existing = this.#decoders.get(peerIndex);
    if (existing && existing.decoder.state !== "closed") return existing;
    const context = this.#audioContext;
    if (!context) return null;
    const state: DecoderState = {
      decoder: new AudioDecoder({
        error: () => this.#closeDecoder(peerIndex),
        output: (audio) => {
          try {
            const samples = new Float32Array(audio.numberOfFrames);
            audio.copyTo(samples, { planeIndex: 0 });
            const buffer = context.createBuffer(
              1,
              audio.numberOfFrames,
              audio.sampleRate,
            );
            buffer.copyToChannel(samples, 0);
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            const now = context.currentTime;
            const scheduled = Math.max(now + 0.04, state.nextTime);
            source.start(scheduled);
            state.nextTime = scheduled + audio.duration / 1_000_000;
            if (state.nextTime - now > 0.5) state.nextTime = now + 0.04;
          } finally {
            audio.close();
          }
        },
      }),
      nextTime: context.currentTime + 0.04,
    };
    state.decoder.configure({
      codec: "opus",
      numberOfChannels: 1,
      sampleRate: SAMPLE_RATE,
    });
    this.#decoders.set(peerIndex, state);
    return state;
  }

  #replacePeers(peers: readonly Peer[]): void {
    const nextIndices = new Set(peers.map((peer) => peer.peer_index));
    for (const index of this.#peerPubkeys.keys()) {
      if (!nextIndices.has(index)) this.#closeDecoder(index);
    }
    this.#peerPubkeys = new Map(
      peers.map((peer) => [peer.peer_index, peer.pubkey]),
    );
    this.#syncRoster();
  }

  #syncRoster(): void {
    const config = this.#config;
    if (!config) return;
    void this.#invoke("sync_huddle_audio_roster", {
      ephemeralChannelId: config.ephemeral_channel_id,
      participants: [...new Set(this.#peerPubkeys.values())],
    }).catch(() => undefined);
  }

  #emitActiveSpeakers(): void {
    const now = performance.now();
    for (const [pubkey, seen] of this.#speakers) {
      if (now - seen > SPEAKER_HOLD_MS) this.#speakers.delete(pubkey);
    }
    this.#emit("huddle-active-speakers", [...this.#speakers.keys()]);
  }

  #closeDecoder(peerIndex: number): void {
    const state = this.#decoders.get(peerIndex);
    this.#decoders.delete(peerIndex);
    if (state && state.decoder.state !== "closed") {
      try {
        state.decoder.close();
      } catch {
        // Already closing.
      }
    }
  }

  async #onClose(generation: number): Promise<void> {
    if (generation !== this.#connectGeneration) return;
    await this.#disposeMedia();
    if (!this.#intentionalClose) {
      this.#emit("huddle-audio-disconnected", null);
    }
  }

  async #disposeMedia(): Promise<void> {
    if (this.#speakerTimer) window.clearInterval(this.#speakerTimer);
    this.#speakerTimer = 0;
    this.#speakers.clear();
    this.#emit("huddle-active-speakers", []);
    for (const index of [...this.#decoders.keys()]) this.#closeDecoder(index);
    this.#peerPubkeys.clear();
    this.#levels.length = 0;
    const encoder = this.#encoder;
    this.#encoder = null;
    if (encoder && encoder.state !== "closed") {
      try {
        encoder.close();
      } catch {
        // Already closing.
      }
    }
    const context = this.#audioContext;
    this.#audioContext = null;
    if (context && context.state !== "closed") await context.close();
    this.#sequence = 0;
    this.#outputTimestamp48k = 0;
    this.#timestamp48k = 0;
  }

  async #applyOutputDevice(): Promise<void> {
    const context = this.#audioContext;
    if (!context) return;
    const selected = localStorage.getItem("buzz.huddle.output-device-id") ?? "";
    const sinkContext = context as AudioContext & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    if (sinkContext.setSinkId) {
      await sinkContext.setSinkId(selected).catch(() => undefined);
    }
  }
}

function requireWebCodecs(): void {
  if (
    typeof AudioEncoder === "undefined" ||
    typeof AudioDecoder === "undefined" ||
    typeof AudioData === "undefined" ||
    typeof EncodedAudioChunk === "undefined"
  ) {
    throw new Error(
      "Huddle audio requires a Chromium browser with WebCodecs Opus support",
    );
  }
}

function parseAudioConfig(value: unknown): AudioConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("host returned an invalid huddle audio configuration");
  }
  const input = value as Record<string, unknown>;
  const audioUrl = requireUrl(input.audio_url, "audio_url");
  const relayUrl = requireUrl(input.relay_url, "relay_url");
  if (
    audioUrl.protocol !== relayUrl.protocol ||
    audioUrl.host !== relayUrl.host
  ) {
    throw new Error(
      "audio relay origin does not match the authenticated relay",
    );
  }
  return {
    audio_url: audioUrl.toString(),
    ephemeral_channel_id: requireUuid(
      input.ephemeral_channel_id,
      "ephemeral_channel_id",
    ),
    parent_channel_id: requireUuid(
      input.parent_channel_id,
      "parent_channel_id",
    ),
    relay_url: relayUrl.toString().replace(/\/$/, ""),
  };
}

function requireUrl(value: unknown, name: string): URL {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error(`${name} must be a bounded URL`);
  }
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must use secure WebSocket transport`);
  }
  return url;
}

function requireUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function requirePcm(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("push_audio_pcm expects raw bytes");
  }
  if (
    value.byteLength < 4 ||
    value.byteLength > 100 * 1024 ||
    value.byteLength % 4 !== 0
  ) {
    throw new Error("PCM batch has an invalid byte length");
  }
  return value;
}

function parseControl(text: string): Record<string, unknown> {
  if (text.length > 64 * 1024)
    throw new Error("audio control frame is too large");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("audio control frame has an invalid shape");
  }
  return parsed as Record<string, unknown>;
}

function parsePeers(value: unknown): Peer[] {
  if (!Array.isArray(value) || value.length > 255) {
    throw new Error("audio relay roster is invalid");
  }
  const peers = value.map((entry) => {
    const peer = parsePeer(entry);
    if (!peer) throw new Error("audio relay roster contains an invalid peer");
    return peer;
  });
  if (
    new Set(peers.map((peer) => peer.peer_index)).size !== peers.length ||
    new Set(peers.map((peer) => peer.pubkey)).size !== peers.length
  ) {
    throw new Error("audio relay roster contains duplicate identities");
  }
  return peers;
}

function parsePeer(value: unknown): Peer | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.peer_index !== "number" ||
    !Number.isInteger(input.peer_index) ||
    input.peer_index < 0 ||
    input.peer_index > 254 ||
    typeof input.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.pubkey)
  ) {
    return null;
  }
  return { peer_index: input.peer_index, pubkey: input.pubkey };
}

function audioLevelDbov(samples: Float32Array): number {
  let squareSum = 0;
  for (const sample of samples) {
    const safe = Number.isFinite(sample)
      ? Math.max(-1, Math.min(1, sample))
      : 0;
    squareSum += safe * safe;
  }
  if (squareSum === 0) return -127;
  const decibels = 20 * Math.log10(Math.sqrt(squareSum / samples.length));
  return Math.max(-127, Math.min(0, Math.round(decibels)));
}

function waitForText<T>(
  socket: WebSocket,
  accept: (text: string) => T | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const value = accept(event.data);
        if (value === undefined) return;
        cleanup();
        resolve(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("audio relay closed during authentication"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error("audio relay sent an unsupported binary frame");
}

function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(message)),
      milliseconds,
    );
    operation.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

import sharp from "sharp";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEX_PUBKEY = /^[0-9a-f]{64}$/;

export type SnapshotMemoryLevel = "none" | "core" | "everything";
export type SnapshotFormat = "json" | "png";

export type AgentSnapshot = {
  readonly format: "buzz-agent-snapshot";
  readonly version: 1;
  readonly definition: {
    readonly name: string;
    readonly systemPrompt?: string;
    readonly runtime?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly parallelism?: number;
    readonly respondTo?: "owner-only" | "allowlist" | "anyone";
    readonly respondToAllowlist?: readonly string[];
    readonly namePool?: readonly string[];
    readonly idleTimeoutSeconds?: number;
    readonly maxTurnDurationSeconds?: number;
  };
  readonly profile: {
    readonly displayName: string;
    readonly about?: string;
    readonly avatarDataUrl?: string;
    readonly avatarUrl?: string;
  };
  readonly memory: {
    readonly level: SnapshotMemoryLevel;
    readonly entries: readonly {
      readonly slug: string;
      readonly body: string;
    }[];
  };
};

export type TeamSnapshot = {
  readonly format: "buzz-team-snapshot";
  readonly version: 1;
  readonly team: {
    readonly name: string;
    readonly description?: string;
    readonly instructions?: string;
  };
  readonly members: readonly AgentSnapshot[];
};

export async function decodeAgentSnapshot(
  bytes: Uint8Array,
): Promise<AgentSnapshot> {
  const value = startsWithPng(bytes)
    ? await manifestFromPng(bytes, "buzz_agent_snapshot")
    : manifestFromJson(bytes);
  validateAgentSnapshot(value);
  return value;
}

export async function decodeTeamSnapshot(
  bytes: Uint8Array,
): Promise<TeamSnapshot> {
  const value = startsWithPng(bytes)
    ? await manifestFromPng(bytes, "buzz_team_snapshot")
    : manifestFromJson(bytes);
  validateTeamSnapshot(value);
  return value;
}

export async function encodeAgentSnapshot(
  value: AgentSnapshot,
  format: SnapshotFormat,
  avatarDataUrl?: string,
): Promise<Uint8Array> {
  validateAgentSnapshot(value);
  if (format === "json") return prettyJson(value);
  return encodePngManifest(value, "buzz_agent_snapshot", avatarDataUrl);
}

export async function encodeTeamSnapshot(
  value: TeamSnapshot,
  format: SnapshotFormat,
): Promise<Uint8Array> {
  validateTeamSnapshot(value);
  if (format === "json") return prettyJson(value);
  return encodePngManifest(value, "buzz_team_snapshot");
}

export function startsWithPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= PNG_MAGIC.byteLength &&
    Buffer.from(bytes.subarray(0, PNG_MAGIC.byteLength)).equals(PNG_MAGIC)
  );
}

export function validateAgentSnapshot(
  value: unknown,
): asserts value is AgentSnapshot {
  const snapshot = object(value, "agent snapshot");
  if (snapshot.format !== "buzz-agent-snapshot" || snapshot.version !== 1) {
    throw new Error("snapshot must be buzz-agent-snapshot version 1");
  }
  const definition = object(snapshot.definition, "snapshot.definition");
  text(definition.name, "snapshot.definition.name", 128, true);
  optionalText(
    definition.systemPrompt,
    "snapshot.definition.systemPrompt",
    1024 * 1024,
  );
  optionalText(definition.runtime, "snapshot.definition.runtime", 128);
  optionalText(definition.model, "snapshot.definition.model", 1_024);
  optionalText(definition.provider, "snapshot.definition.provider", 128);
  optionalInteger(
    definition.parallelism,
    "snapshot.definition.parallelism",
    1,
    32,
  );
  optionalInteger(
    definition.idleTimeoutSeconds,
    "snapshot.definition.idleTimeoutSeconds",
    1,
    604_800,
  );
  optionalInteger(
    definition.maxTurnDurationSeconds,
    "snapshot.definition.maxTurnDurationSeconds",
    10,
    604_800,
  );
  if (
    definition.respondTo !== undefined &&
    definition.respondTo !== "owner-only" &&
    definition.respondTo !== "allowlist" &&
    definition.respondTo !== "anyone"
  ) {
    throw new Error("snapshot.definition.respondTo is invalid");
  }
  const allowlist = stringArray(
    definition.respondToAllowlist,
    "snapshot.definition.respondToAllowlist",
    100,
    64,
  );
  if (allowlist.some((pubkey) => !HEX_PUBKEY.test(pubkey))) {
    throw new Error("snapshot definition contains an invalid allowlist pubkey");
  }
  if (definition.respondTo === "allowlist" && allowlist.length === 0) {
    throw new Error("snapshot allowlist mode requires at least one pubkey");
  }
  stringArray(definition.namePool, "snapshot.definition.namePool", 100, 128);

  const profile = object(snapshot.profile, "snapshot.profile");
  text(profile.displayName, "snapshot.profile.displayName", 128, true);
  optionalText(profile.about, "snapshot.profile.about", 4_096);
  optionalAvatarDataUrl(profile.avatarDataUrl);
  optionalWebUrl(profile.avatarUrl, "snapshot.profile.avatarUrl");

  const memory = object(snapshot.memory, "snapshot.memory");
  if (
    memory.level !== "none" &&
    memory.level !== "core" &&
    memory.level !== "everything"
  ) {
    throw new Error("snapshot.memory.level is invalid");
  }
  if (!Array.isArray(memory.entries) || memory.entries.length > 10_000) {
    throw new Error("snapshot.memory.entries is invalid");
  }
  if (memory.level === "none" && memory.entries.length > 0) {
    throw new Error("snapshot with memory level none cannot contain entries");
  }
  for (const [index, entryValue] of memory.entries.entries()) {
    const entry = object(entryValue, `snapshot.memory.entries[${index}]`);
    text(entry.slug, `snapshot.memory.entries[${index}].slug`, 512, true);
    text(
      entry.body,
      `snapshot.memory.entries[${index}].body`,
      1024 * 1024,
      false,
    );
  }
}

export function validateTeamSnapshot(
  value: unknown,
): asserts value is TeamSnapshot {
  const snapshot = object(value, "team snapshot");
  if (snapshot.format !== "buzz-team-snapshot" || snapshot.version !== 1) {
    throw new Error("snapshot must be buzz-team-snapshot version 1");
  }
  const team = object(snapshot.team, "snapshot.team");
  text(team.name, "snapshot.team.name", 128, true);
  optionalText(team.description, "snapshot.team.description", 4_096);
  optionalText(team.instructions, "snapshot.team.instructions", 1024 * 1024);
  if (!Array.isArray(snapshot.members) || snapshot.members.length > 500) {
    throw new Error("snapshot.members must contain at most 500 agents");
  }
  for (const member of snapshot.members) validateAgentSnapshot(member);
}

async function manifestFromPng(
  bytes: Uint8Array,
  keyword: "buzz_agent_snapshot" | "buzz_team_snapshot",
): Promise<unknown> {
  try {
    const metadata = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 25_000_000,
      sequentialRead: true,
    }).metadata();
    if (!metadata.width || !metadata.height)
      throw new Error("missing dimensions");
  } catch {
    throw new Error("snapshot PNG cannot be decoded safely");
  }
  let offset = PNG_MAGIC.byteLength;
  let encoded: string | undefined;
  while (offset + 12 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength)
      throw new Error("snapshot PNG is truncated");
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString(
      "ascii",
    );
    if (type === "tEXt") {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      if (
        separator === keyword.length &&
        Buffer.from(data.subarray(0, separator)).toString("latin1") === keyword
      ) {
        if (encoded !== undefined) {
          throw new Error(
            `snapshot PNG contains duplicate ${keyword} metadata`,
          );
        }
        encoded = Buffer.from(data.subarray(separator + 1))
          .toString("latin1")
          .trim();
      }
    }
    offset = chunkEnd;
    if (type === "IEND") break;
  }
  if (encoded === undefined) {
    throw new Error(`snapshot PNG is missing ${keyword} metadata`);
  }
  if (
    encoded.length === 0 ||
    encoded.length > 40 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new Error("snapshot PNG contains invalid base64 metadata");
  }
  return manifestFromJson(Buffer.from(encoded, "base64"));
}

function manifestFromJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("snapshot contains malformed JSON");
  }
}

async function encodePngManifest(
  value: AgentSnapshot | TeamSnapshot,
  keyword: "buzz_agent_snapshot" | "buzz_team_snapshot",
  avatarDataUrl?: string,
): Promise<Uint8Array> {
  const base = avatarDataUrl ? decodeAvatarDataUrl(avatarDataUrl) : undefined;
  const png = base
    ? await sharp(base, {
        animated: false,
        failOn: "warning",
        limitInputPixels: 25_000_000,
        sequentialRead: true,
      })
        .rotate()
        .png({ compressionLevel: 9 })
        .toBuffer()
    : await sharp({
        create: {
          background: { alpha: 0, b: 0, g: 0, r: 0 },
          channels: 4,
          height: 1,
          width: 1,
        },
      })
        .png()
        .toBuffer();
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const textData = Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]),
    Buffer.from(encoded, "latin1"),
  ]);
  const textChunk = pngChunk("tEXt", textData);
  const iend = findIend(png);
  return Buffer.concat([png.subarray(0, iend), textChunk, png.subarray(iend)]);
}

function prettyJson(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function findIend(png: Uint8Array): number {
  let offset = PNG_MAGIC.byteLength;
  while (offset + 12 <= png.byteLength) {
    const length = new DataView(
      png.buffer,
      png.byteOffset + offset,
      4,
    ).getUint32(0);
    const end = offset + 12 + length;
    if (end > png.byteLength) throw new Error("generated PNG is truncated");
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString(
      "ascii",
    );
    if (type === "IEND") return offset;
    offset = end;
  }
  throw new Error("generated PNG has no IEND chunk");
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, Buffer.from(data)])),
    8 + data.byteLength,
  );
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeAvatarDataUrl(value: string): Uint8Array {
  optionalAvatarDataUrl(value);
  const encoded = value.slice(value.indexOf(",") + 1);
  return Buffer.from(encoded, "base64");
}

function optionalAvatarDataUrl(value: unknown): void {
  if (value === undefined || value === null) return;
  if (
    typeof value !== "string" ||
    value.length > 3 * 1024 * 1024 ||
    !/^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i.test(
      value,
    )
  ) {
    throw new Error("snapshot.profile.avatarDataUrl is invalid");
  }
}

function optionalWebUrl(value: unknown, name: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error(`${name} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} is invalid`);
  }
}

function stringArray(
  value: unknown,
  name: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${name} is invalid`);
  }
  return value.map((item, index) =>
    text(item, `${name}[${index}]`, maximumLength, true),
  );
}

function optionalText(value: unknown, name: string, maximum: number): void {
  if (value === undefined || value === null) return;
  text(value, name, maximum, false);
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined || value === null) return;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${name} is invalid`);
  }
}

function text(
  value: unknown,
  name: string,
  maximum: number,
  nonEmpty: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (nonEmpty && value.trim().length === 0)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

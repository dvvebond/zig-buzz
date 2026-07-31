export type MediaConfig = {
  readonly publicBaseUrl: string;
  readonly maxImageBytes: number;
  readonly maxGifBytes: number;
  readonly maxVideoBytes: number;
  readonly maxFileBytes: number;
  readonly uploadRecordsEnabled: boolean;
  readonly uploadIpHeader?: string;
  readonly uploadPortHeader?: string;
};

export function validateMediaConfig(config: MediaConfig): MediaConfig {
  let url: URL;
  try {
    url = new URL(config.publicBaseUrl);
  } catch {
    throw new Error("media publicBaseUrl must be an absolute URL");
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      )) ||
    url.pathname !== "/media" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "media publicBaseUrl must be HTTPS (HTTP only for loopback) and end exactly in /media",
    );
  }
  for (const [name, value] of [
    ["maxImageBytes", config.maxImageBytes],
    ["maxGifBytes", config.maxGifBytes],
    ["maxVideoBytes", config.maxVideoBytes],
    ["maxFileBytes", config.maxFileBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (config.maxGifBytes > config.maxImageBytes) {
    throw new Error("maxGifBytes must be less than or equal to maxImageBytes");
  }
  if (config.uploadIpHeader && !config.uploadRecordsEnabled) {
    throw new Error(
      "uploadIpHeader requires uploadRecordsEnabled so collection is not silently disabled",
    );
  }
  if (config.uploadPortHeader && !config.uploadIpHeader) {
    throw new Error("uploadPortHeader requires uploadIpHeader");
  }
  for (const value of [config.uploadIpHeader, config.uploadPortHeader]) {
    if (value && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
      throw new Error(`invalid trusted upload header name: ${value}`);
    }
  }
  return config;
}

export const DEFAULT_MEDIA_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxGifBytes: 10 * 1024 * 1024,
  maxImageBytes: 50 * 1024 * 1024,
  maxVideoBytes: 500 * 1024 * 1024,
} as const;

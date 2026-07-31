import { RemoteProtocolError } from "./errors.js";

export function validateRemoteRelayUrl(
  value: string,
  allowInsecureLocalhost = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "relay URL is not a valid absolute URL",
    );
  }

  if (url.username || url.password) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "relay URL must not contain credentials",
    );
  }
  if (url.protocol === "wss:") return url;

  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "ws:" && isLoopback && allowInsecureLocalhost) {
    return url;
  }

  throw new RemoteProtocolError(
    "CONFIG_INVALID",
    "remote relay connections require wss://; ws:// is allowed only for explicitly enabled loopback development",
  );
}

export interface RelayBinding {
  readonly host: string;
  readonly port: number;
}

/**
 * Resolve the TypeScript relay listener while preserving the deployed
 * BUZZ_BIND_ADDR contract used by older Compose and Helm releases.
 */
export function resolveRelayBinding(
  environment: Readonly<Record<string, string | undefined>>,
): RelayBinding {
  const legacy = environment.BUZZ_BIND_ADDR
    ? parseBindAddress(environment.BUZZ_BIND_ADDR)
    : undefined;
  return {
    host: environment.BUZZ_HOST?.trim() || legacy?.host || "127.0.0.1",
    port: parseRelayPort(
      environment.BUZZ_PORT?.trim() || String(legacy?.port ?? 3_000),
    ),
  };
}

export function resolveRelayRedisUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return environment.BUZZ_REDIS_URL?.trim() || environment.REDIS_URL?.trim();
}

function parseBindAddress(value: string): RelayBinding {
  const candidate = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(`http://${candidate}/`);
  } catch {
    throw new Error(
      "BUZZ_BIND_ADDR must be a host and port such as 0.0.0.0:3000",
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname ||
    !parsed.port
  ) {
    throw new Error(
      "BUZZ_BIND_ADDR must be a host and port such as 0.0.0.0:3000",
    );
  }
  const hostname = parsed.hostname;
  return {
    host:
      hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname,
    port: parseRelayPort(parsed.port),
  };
}

function parseRelayPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("BUZZ_PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

import { isIP } from "node:net";

import { AppProfileSchema, type AppProfile } from "./model.js";
import type { KeyConfig } from "./crypto.js";

export type PushGatewayConfig = {
  readonly bind: { readonly host: string; readonly port: number };
  readonly health: { readonly host: string; readonly port: number };
  readonly publicDeliveryUrl: string;
  readonly maxGrantLifetimeSeconds: number;
  readonly maxInstallationLifetimeSeconds: number;
  readonly endpointQuotaWindowSeconds: number;
  readonly endpointQuotaMaxDeliveries: number;
  readonly enabledProfiles: ReadonlySet<AppProfile>;
  readonly databaseUrl: string;
  readonly appAttestAppId: string;
  readonly appAttestRootCertPath: string;
  readonly grantKeys: readonly KeyConfig[];
  readonly tokenKeys: readonly KeyConfig[];
  readonly apnsKeyPath: string;
  readonly apnsKeyId: string;
  readonly apnsTeamId: string;
  readonly apnsTopic: string;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PushGatewayConfig {
  const grantKeys = keyring(required(environment, "BUZZ_PUSH_GRANT_KEYS"));
  const tokenKeys = keyring(required(environment, "BUZZ_PUSH_TOKEN_KEYS"));
  if (
    grantKeys.some((grant) =>
      tokenKeys.some(
        (token) =>
          token.id === grant.id ||
          Buffer.from(token.key).equals(Buffer.from(grant.key)),
      ),
    )
  ) {
    throw new Error("grant and token custody keyrings must be independent");
  }
  const publicDeliveryUrl = required(
    environment,
    "BUZZ_PUSH_PUBLIC_DELIVERY_URL",
  );
  const url = new URL(publicDeliveryUrl);
  if (
    url.href !== "https://push.buzz.xyz/v1/deliveries/apns" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error("invalid BUZZ_PUSH_PUBLIC_DELIVERY_URL");
  }
  const enabledProfiles = new Set(
    required(environment, "BUZZ_PUSH_ENABLED_PROFILES")
      .split(",")
      .map((value) => AppProfileSchema.parse(value)),
  );
  if (enabledProfiles.size === 0) {
    throw new Error("at least one push profile must be enabled");
  }
  return {
    apnsKeyId: required(environment, "BUZZ_PUSH_APNS_KEY_ID"),
    apnsKeyPath: required(environment, "BUZZ_PUSH_APNS_KEY_PATH"),
    apnsTeamId: required(environment, "BUZZ_PUSH_APNS_TEAM_ID"),
    apnsTopic: required(environment, "BUZZ_PUSH_APNS_TOPIC"),
    appAttestAppId: required(environment, "BUZZ_PUSH_APP_ATTEST_APP_ID"),
    appAttestRootCertPath: required(
      environment,
      "BUZZ_PUSH_APP_ATTEST_ROOT_CERT_PATH",
    ),
    bind: address(environment.BUZZ_PUSH_BIND_ADDR ?? "0.0.0.0:8080"),
    databaseUrl: required(environment, "DATABASE_URL"),
    enabledProfiles,
    endpointQuotaMaxDeliveries: bounded(
      environment.BUZZ_PUSH_ENDPOINT_QUOTA_MAX_DELIVERIES,
      10,
      10_000,
    ),
    endpointQuotaWindowSeconds: bounded(
      environment.BUZZ_PUSH_ENDPOINT_QUOTA_WINDOW_SECONDS,
      10,
      86_400,
    ),
    grantKeys,
    health: address(environment.BUZZ_PUSH_HEALTH_ADDR ?? "0.0.0.0:8081"),
    maxGrantLifetimeSeconds: bounded(
      required(environment, "BUZZ_PUSH_MAX_GRANT_LIFETIME_SECONDS"),
      undefined,
      31_536_000,
    ),
    maxInstallationLifetimeSeconds: bounded(
      environment.BUZZ_PUSH_MAX_INSTALLATION_LIFETIME_SECONDS,
      7_776_000,
      31_536_000,
    ),
    publicDeliveryUrl,
    tokenKeys,
  };
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function keyring(value: string): KeyConfig[] {
  const seen = new Set<string>();
  return value.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error("invalid push keyring");
    const id = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), "base64");
    if (seen.has(id) || key.byteLength !== 32) {
      throw new Error("invalid push keyring");
    }
    seen.add(id);
    return { id, key };
  });
}

function bounded(
  value: string | undefined,
  fallback: number | undefined,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("invalid bounded push gateway setting");
  }
  return parsed;
}

function address(value: string): {
  readonly host: string;
  readonly port: number;
} {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (
    !host ||
    (isIP(host) === 0 && host !== "localhost") ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("invalid push gateway bind address");
  }
  return { host, port };
}

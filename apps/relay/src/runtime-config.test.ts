import { describe, expect, it } from "vitest";

import { resolveRelayBinding, resolveRelayRedisUrl } from "./runtime-config.js";

describe("relay runtime configuration", () => {
  it("uses the TypeScript listener variables when provided", () => {
    expect(
      resolveRelayBinding({
        BUZZ_BIND_ADDR: "legacy.example:9000",
        BUZZ_HOST: "0.0.0.0",
        BUZZ_PORT: "3030",
      }),
    ).toEqual({ host: "0.0.0.0", port: 3030 });
  });

  it("accepts the deployed BUZZ_BIND_ADDR contract and IPv6 authorities", () => {
    expect(resolveRelayBinding({ BUZZ_BIND_ADDR: "0.0.0.0:3000" })).toEqual({
      host: "0.0.0.0",
      port: 3000,
    });
    expect(resolveRelayBinding({ BUZZ_BIND_ADDR: "[::]:3001" })).toEqual({
      host: "::",
      port: 3001,
    });
  });

  it("rejects incomplete or unsafe bind authorities", () => {
    expect(() => resolveRelayBinding({ BUZZ_BIND_ADDR: "localhost" })).toThrow(
      /host and port/,
    );
    expect(() =>
      resolveRelayBinding({ BUZZ_BIND_ADDR: "user@localhost:3000" }),
    ).toThrow(/host and port/);
    expect(() => resolveRelayBinding({ BUZZ_PORT: "0" })).toThrow(
      /between 1 and 65535/,
    );
  });

  it("prefers BUZZ_REDIS_URL and accepts the deployed REDIS_URL alias", () => {
    expect(
      resolveRelayRedisUrl({
        BUZZ_REDIS_URL: "redis://primary:6379",
        REDIS_URL: "redis://legacy:6379",
      }),
    ).toBe("redis://primary:6379");
    expect(resolveRelayRedisUrl({ REDIS_URL: "redis://legacy:6379" })).toBe(
      "redis://legacy:6379",
    );
  });
});

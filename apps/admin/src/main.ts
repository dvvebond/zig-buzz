#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Pool } from "pg";
import { RedisEventBus } from "@buzz/pubsub";

import { BuzzAdmin } from "./admin.js";

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "generate-key") {
    const secret = generateSecretKey();
    process.stdout.write(
      `${JSON.stringify({
        publicKey: getPublicKey(secret),
        secretKey: Buffer.from(secret).toString("hex"),
      })}\n`,
    );
    secret.fill(0);
    return;
  }
  const pool = new Pool({
    connectionString:
      process.env.BUZZ_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://buzz:buzz_dev@localhost:5432/buzz",
  });
  const eventBus =
    (process.env.BUZZ_REDIS_URL ?? process.env.REDIS_URL)
      ? new RedisEventBus(
          process.env.BUZZ_REDIS_URL ??
            process.env.REDIS_URL ??
            "redis://localhost:6379",
        )
      : undefined;
  const secret = relaySecret();
  const admin = new BuzzAdmin(pool, resolveCommunity(), secret, eventBus);
  try {
    let result: unknown;
    if (command === "add-member") {
      const values = args(arguments_, {
        pubkey: { type: "string" },
        role: { type: "string", default: "member" },
      });
      result = await admin.addMember(
        required(values.pubkey, "--pubkey"),
        values.role as string,
      );
    } else if (command === "remove-member") {
      const values = args(arguments_, {
        pubkey: { type: "string" },
        role: { type: "string" },
      });
      result = await admin.removeMember(
        required(values.pubkey, "--pubkey"),
        values.role,
      );
    } else if (command === "list-members") {
      result = await admin.listMembers();
    } else if (command === "product-feedback") {
      const values = args(arguments_, {
        limit: { type: "string", default: "100" },
      });
      result = await admin.listProductFeedback(Number(values.limit));
    } else if (command === "reconcile-channels") {
      result = await admin.reconcileChannels();
    } else if (command === "migrate") {
      const values = args(arguments_, {
        directory: { type: "string", default: "migrations" },
      });
      result = {
        applied: await admin.migrate(resolve(values.directory as string)),
      };
    } else {
      throw new Error(
        "usage: buzz-admin generate-key | add-member --pubkey <key> [--role member|admin] | remove-member --pubkey <key> [--role ...] | list-members | product-feedback [--limit N] | reconcile-channels | migrate [--directory migrations]",
      );
    }
    process.stdout.write(`${JSON.stringify({ data: result, ok: true })}\n`);
  } finally {
    secret?.fill(0);
    await eventBus?.close();
    await pool.end();
  }
}

function args<T extends Record<string, { type: "string"; default?: string }>>(
  positionals: string[],
  options: T,
): Record<keyof T, string | undefined> {
  const parsed = parseArgs({
    args: positionals,
    allowPositionals: false,
    options,
    strict: true,
  });
  return parsed.values as unknown as Record<keyof T, string | undefined>;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function relaySecret(): Uint8Array | undefined {
  const value = process.env.BUZZ_RELAY_PRIVATE_KEY;
  if (!value) return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      "BUZZ_RELAY_PRIVATE_KEY must be 64 lowercase hex characters",
    );
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function resolveCommunity(): string {
  if (process.env.BUZZ_COMMUNITY) return process.env.BUZZ_COMMUNITY;
  const value =
    process.env.BUZZ_PUBLIC_URL ??
    process.env.RELAY_URL ??
    "ws://localhost:3000";
  const url = new URL(value);
  const defaultPort =
    (url.protocol === "ws:" && url.port === "80") ||
    (url.protocol === "wss:" && url.port === "443");
  return `${url.hostname.toLowerCase()}${url.port && !defaultPort ? `:${url.port}` : ""}`;
}

void main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      error: {
        code: "ADMIN_FAILED",
        message:
          error instanceof Error ? error.message : "admin command failed",
      },
      ok: false,
    })}\n`,
  );
  process.exitCode = 1;
});

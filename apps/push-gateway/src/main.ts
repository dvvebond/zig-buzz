#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { AppleAppAttestVerifier } from "./app-attest.js";
import { ApnsTransport } from "./apns.js";
import { loadConfig } from "./config.js";
import { GrantKeyring, TokenKeyring } from "./crypto.js";
import { PushGatewayHttp } from "./http.js";
import { PostgresAuthorityStore } from "./postgres.js";

let server: PushGatewayHttp | undefined;
let pool: Pool | undefined;
let accepting = true;
let reaper: NodeJS.Timeout | undefined;

try {
  if (process.argv.includes("--migrate-only")) {
    const databaseUrl = process.env.DATABASE_URL;
    const runtimeRole = process.env.BUZZ_PUSH_RUNTIME_DATABASE_ROLE;
    if (!databaseUrl || !runtimeRole) {
      throw new Error(
        "DATABASE_URL and BUZZ_PUSH_RUNTIME_DATABASE_ROLE are required",
      );
    }
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await migrate(pool, runtimeRole);
    await pool.end();
    pool = undefined;
  } else {
    const config = loadConfig();
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 20,
    });
    const authority = new PostgresAuthorityStore(pool);
    await authority.ready();
    await authority.reapExpired(Math.floor(Date.now() / 1_000));
    const gateway = new PushGatewayHttp({
      accepting: () => accepting,
      appAttest: new AppleAppAttestVerifier(
        config.appAttestAppId,
        await readFile(config.appAttestRootCertPath),
      ),
      authority,
      deliveryUrl: config.publicDeliveryUrl,
      enabledProfiles: config.enabledProfiles,
      endpointQuotaMaxDeliveries: config.endpointQuotaMaxDeliveries,
      endpointQuotaWindowSeconds: config.endpointQuotaWindowSeconds,
      grantKeyring: new GrantKeyring(config.grantKeys),
      maxGrantLifetimeSeconds: config.maxGrantLifetimeSeconds,
      maxInstallationLifetimeSeconds: config.maxInstallationLifetimeSeconds,
      tokenKeyring: new TokenKeyring(config.tokenKeys),
      transport: new ApnsTransport(
        await readFile(config.apnsKeyPath),
        config.apnsKeyId,
        config.apnsTeamId,
        config.apnsTopic,
      ),
    });
    server = gateway;
    const address = await gateway.listen({
      healthHost: config.health.host,
      healthPort: config.health.port,
      publicHost: config.bind.host,
      publicPort: config.bind.port,
    });
    process.stderr.write(
      `buzz-push-gateway public=${address.publicUrl} health=${address.healthUrl}\n`,
    );
    reaper = setInterval(() => {
      void authority.reapExpired(Math.floor(Date.now() / 1_000)).catch(() => {
        process.stderr.write("push gateway retention reaper failed\n");
      });
    }, 300_000);
    reaper.unref();
  }
} catch (error) {
  process.stderr.write(
    `fatal: ${error instanceof Error ? error.message : "push gateway failed"}\n`,
  );
  process.exitCode = 1;
  await pool?.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    accepting = false;
    if (reaper) clearInterval(reaper);
    void server
      ?.close()
      .then(() => pool?.end())
      .finally(() => {
        process.exitCode = 0;
      });
  });
}

async function migrate(database: Pool, runtimeRole: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(runtimeRole)) {
    throw new Error("runtime database role must be a PostgreSQL identifier");
  }
  const sql = await readFile(
    new URL("../migrations/0001_push_gateway_authority.sql", import.meta.url),
    "utf8",
  );
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(867530901)");
    const exists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.push_gateway_installations') IS NOT NULL AS exists",
    );
    if (exists.rows[0]?.exists !== true) await client.query(sql);
    const databaseName = await client.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    const role = quoteIdentifier(runtimeRole);
    const name = quoteIdentifier(databaseName.rows[0]?.name ?? "");
    await client.query(
      `REVOKE CREATE ON DATABASE ${name} FROM ${role};
       REVOKE CREATE ON SCHEMA public FROM PUBLIC;
       REVOKE CREATE ON SCHEMA public FROM ${role};
       GRANT CONNECT ON DATABASE ${name} TO ${role};
       GRANT USAGE ON SCHEMA public TO ${role};
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
         push_gateway_challenges,
         push_gateway_installations,
         push_gateway_delegations,
         push_gateway_endpoint_quotas,
         push_gateway_delivery_auth_replays,
         push_gateway_delivery_request_replays
       TO ${role}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function quoteIdentifier(value: string): string {
  if (!value) throw new Error("database identifier is empty");
  return `"${value.replaceAll('"', '""')}"`;
}

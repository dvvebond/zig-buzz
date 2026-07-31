import { createHash } from "node:crypto";

import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import {
  AuthorityError,
  type AuthorityStore,
  type Challenge,
  type Delegation,
  type DeliveryDisposition,
  type DeliveryPermit,
  type Installation,
  type NewInstallation,
} from "./authority.js";
import { AppProfileSchema, type AppProfile } from "./model.js";

export class PostgresAuthorityStore implements AuthorityStore {
  public constructor(private readonly pool: Pool) {}

  public async ready(): Promise<void> {
    try {
      await this.pool.query("SELECT 1");
      for (const table of TABLES) {
        const result = await this.pool.query<{ ready: boolean }>(
          `SELECT to_regclass($1) IS NOT NULL
             AND COALESCE(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false)
             AND COALESCE(has_table_privilege(current_user, to_regclass($1), 'INSERT'), false)
             AND COALESCE(has_table_privilege(current_user, to_regclass($1), 'UPDATE'), false)
             AND COALESCE(has_table_privilege(current_user, to_regclass($1), 'DELETE'), false)
             AS ready`,
          [`public.${table}`],
        );
        if (result.rows[0]?.ready !== true) unavailable();
      }
    } catch (error) {
      if (error instanceof AuthorityError) throw error;
      unavailable();
    }
  }

  public async putChallenge(challenge: Challenge): Promise<void> {
    await this.#query(
      `INSERT INTO push_gateway_challenges(id, challenge_hash, expires_at)
       VALUES($1, $2, to_timestamp($3))`,
      [
        challenge.id,
        createHash("sha256").update(challenge.value).digest(),
        challenge.expiresAt,
      ],
    );
  }

  public async consumeChallenge(
    id: string,
    value: Uint8Array,
    now: number,
  ): Promise<void> {
    const result = await this.#query(
      `DELETE FROM push_gateway_challenges
       WHERE id=$1 AND challenge_hash=$2 AND expires_at >= to_timestamp($3)`,
      [id, createHash("sha256").update(value).digest(), now],
    );
    if (result.rowCount !== 1) reject();
  }

  public async createInstallation(value: NewInstallation): Promise<void> {
    const result = await this.#query(
      `INSERT INTO push_gateway_installations(
         id, app_attest_key_id, app_attest_public_key, assertion_counter,
         app_profile, token_ciphertext, token_fingerprint, endpoint_epoch,
         expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))
       ON CONFLICT DO NOTHING`,
      [
        value.id,
        value.appAttestKeyId,
        value.appAttestPublicKey,
        value.assertionCounter,
        value.profile,
        value.tokenCiphertext,
        value.tokenFingerprint,
        value.endpointEpoch,
        value.expiresAt,
      ],
    );
    if (result.rowCount !== 1) reject();
  }

  public async installation(id: string, now: number): Promise<Installation> {
    const result = await this.#query<InstallationRow>(
      `SELECT *, extract(epoch FROM expires_at)::bigint AS expires_at_epoch
       FROM push_gateway_installations
       WHERE id=$1 AND revoked_at IS NULL AND expires_at >= to_timestamp($2)`,
      [id, now],
    );
    const row = result.rows[0];
    if (!row) reject();
    return installationFromRow(row);
  }

  public async advanceAssertionCounter(
    id: string,
    previous: number,
    next: number,
  ): Promise<void> {
    if (next <= previous || next > 0xffff_ffff) reject();
    const result = await this.#query(
      `UPDATE push_gateway_installations
       SET assertion_counter=$3, updated_at=now()
       WHERE id=$1 AND assertion_counter=$2 AND revoked_at IS NULL`,
      [id, previous, next],
    );
    if (result.rowCount !== 1) reject();
  }

  public async upsertDelegation(value: Delegation): Promise<void> {
    await this.#transaction(async (client) => {
      const installation = await client.query<{
        endpoint_epoch: string;
        expires_at_epoch: string;
        revoked_at: Date | null;
      }>(
        `SELECT endpoint_epoch,
                extract(epoch FROM expires_at)::bigint AS expires_at_epoch,
                revoked_at
         FROM push_gateway_installations WHERE id=$1 FOR UPDATE`,
        [value.installationId],
      );
      const row = installation.rows[0];
      if (
        !row ||
        row.revoked_at ||
        integer(row.endpoint_epoch) !== value.endpointEpoch ||
        value.expiresAt > integer(row.expires_at_epoch)
      ) {
        reject();
      }
      const result = await client.query(
        `INSERT INTO push_gateway_delegations(
           id, installation_id, relay_pubkey, endpoint_epoch, generation,
           not_before, expires_at, revoked_at
         ) VALUES($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),NULL)
         ON CONFLICT(installation_id,relay_pubkey) DO UPDATE SET
           id=EXCLUDED.id,
           endpoint_epoch=EXCLUDED.endpoint_epoch,
           generation=EXCLUDED.generation,
           not_before=EXCLUDED.not_before,
           expires_at=EXCLUDED.expires_at,
           revoked_at=NULL,
           updated_at=now()
         WHERE EXCLUDED.generation > push_gateway_delegations.generation`,
        [
          value.id,
          value.installationId,
          Buffer.from(value.relayPubkey, "hex"),
          value.endpointEpoch,
          value.generation,
          value.notBefore,
          value.expiresAt,
        ],
      );
      if (result.rowCount !== 1) reject();
    });
  }

  public async rotateEndpoint(
    id: string,
    expected: number,
    next: number,
    ciphertext: Buffer,
    fingerprint: Buffer,
  ): Promise<void> {
    if (next !== expected + 1) reject();
    const result = await this.#query(
      `UPDATE push_gateway_installations SET
         endpoint_epoch=$3, token_ciphertext=$4, token_fingerprint=$5,
         updated_at=now()
       WHERE id=$1 AND endpoint_epoch=$2 AND revoked_at IS NULL`,
      [id, expected, next, ciphertext, fingerprint],
    );
    if (result.rowCount !== 1) reject();
  }

  public async revokeDelegation(
    installationId: string,
    relayPubkey: string,
    generation: number,
  ): Promise<void> {
    const result = await this.#query(
      `UPDATE push_gateway_delegations SET
         generation=$3, revoked_at=now(), updated_at=now()
       WHERE installation_id=$1 AND relay_pubkey=$2 AND generation<$3`,
      [installationId, Buffer.from(relayPubkey, "hex"), generation],
    );
    if (result.rowCount !== 1) reject();
  }

  public async revokeInstallation(
    id: string,
    expected: number,
    next: number,
  ): Promise<void> {
    if (next !== expected + 1) reject();
    const result = await this.#query(
      `UPDATE push_gateway_installations SET
         endpoint_epoch=$3, revoked_at=now(), updated_at=now()
       WHERE id=$1 AND endpoint_epoch=$2 AND revoked_at IS NULL`,
      [id, expected, next],
    );
    if (result.rowCount !== 1) reject();
  }

  public async authorizeDelivery(
    input: Parameters<AuthorityStore["authorizeDelivery"]>[0],
  ): Promise<DeliveryPermit> {
    if (
      !/^[0-9a-f]{64}$/.test(input.relayPubkey) ||
      !/^[0-9a-f]{64}$/.test(input.authEventId) ||
      input.quotaWindowSeconds < 1 ||
      input.quotaMaxDeliveries < 1
    ) {
      reject();
    }
    return this.#transaction(async (client) => {
      const installationResult = await client.query<InstallationRow>(
        `SELECT i.*,
                extract(epoch FROM i.expires_at)::bigint AS expires_at_epoch
         FROM push_gateway_installations i
         WHERE i.id=(
           SELECT installation_id FROM push_gateway_delegations WHERE id=$1
         )
         FOR UPDATE`,
        [input.delegationId],
      );
      const installation = installationResult.rows[0];
      if (
        !installation ||
        installation.revoked_at ||
        integer(installation.endpoint_epoch) !== input.endpointEpoch ||
        integer(installation.expires_at_epoch) < input.now
      ) {
        reject();
      }
      const delegationResult = await client.query<{
        installation_id: string;
        expires_at_epoch: string;
      }>(
        `SELECT installation_id,
                extract(epoch FROM expires_at)::bigint AS expires_at_epoch
         FROM push_gateway_delegations
         WHERE id=$1 AND relay_pubkey=$2 AND endpoint_epoch=$3
           AND generation=$4 AND revoked_at IS NULL
           AND not_before<=to_timestamp($5) AND expires_at>=to_timestamp($5)
         FOR UPDATE`,
        [
          input.delegationId,
          Buffer.from(input.relayPubkey, "hex"),
          input.endpointEpoch,
          input.generation,
          input.now,
        ],
      );
      const delegation = delegationResult.rows[0];
      const delegationExpiresAt = delegation
        ? integer(delegation.expires_at_epoch)
        : -1;
      if (
        !delegation ||
        input.requestExpiresAt < input.now ||
        input.requestExpiresAt > delegationExpiresAt
      ) {
        reject();
      }
      const quota = await client.query(
        `INSERT INTO push_gateway_endpoint_quotas(
           token_fingerprint, window_started_at, admitted
         ) VALUES($1,to_timestamp($2),1)
         ON CONFLICT(token_fingerprint) DO UPDATE SET
           window_started_at=CASE
             WHEN push_gateway_endpoint_quotas.window_started_at
                  <= to_timestamp($2) - make_interval(secs => $3::double precision)
             THEN to_timestamp($2)
             ELSE push_gateway_endpoint_quotas.window_started_at
           END,
           admitted=CASE
             WHEN push_gateway_endpoint_quotas.window_started_at
                  <= to_timestamp($2) - make_interval(secs => $3::double precision)
             THEN 1
             ELSE push_gateway_endpoint_quotas.admitted + 1
           END,
           updated_at=now()
         WHERE push_gateway_endpoint_quotas.window_started_at
                 <= to_timestamp($2) - make_interval(secs => $3::double precision)
            OR push_gateway_endpoint_quotas.admitted < $4`,
        [
          installation.token_fingerprint,
          input.now,
          input.quotaWindowSeconds,
          input.quotaMaxDeliveries,
        ],
      );
      if (quota.rowCount !== 1) reject();
      const auth = await client.query(
        `INSERT INTO push_gateway_delivery_auth_replays(
           relay_pubkey, auth_event_id, expires_at
         ) VALUES($1,$2,to_timestamp($3)) ON CONFLICT DO NOTHING`,
        [
          Buffer.from(input.relayPubkey, "hex"),
          Buffer.from(input.authEventId, "hex"),
          input.requestExpiresAt,
        ],
      );
      const request = await client.query(
        `INSERT INTO push_gateway_delivery_request_replays(
           relay_pubkey, request_id, expires_at
         ) VALUES($1,$2,to_timestamp($3)) ON CONFLICT DO NOTHING`,
        [
          Buffer.from(input.relayPubkey, "hex"),
          input.requestId,
          input.requestExpiresAt,
        ],
      );
      if (auth.rowCount !== 1 || request.rowCount !== 1) reject();
      return {
        authority: {
          delegationId: input.delegationId,
          endpointEpoch: input.endpointEpoch,
          expiresAt: delegationExpiresAt,
          generation: input.generation,
          installationId: delegation.installation_id,
          profile: profile(installation.app_profile),
          relayPubkey: input.relayPubkey,
          tokenCiphertext: Buffer.from(installation.token_ciphertext),
        },
        relayPubkey: input.relayPubkey,
        requestId: input.requestId,
      };
    });
  }

  public async finishDelivery(
    permit: DeliveryPermit,
    disposition: DeliveryDisposition,
  ): Promise<void> {
    if (disposition !== "retryable") return;
    await this.#query(
      `DELETE FROM push_gateway_delivery_request_replays
       WHERE relay_pubkey=$1 AND request_id=$2`,
      [Buffer.from(permit.relayPubkey, "hex"), permit.requestId],
    );
  }

  public async reapExpired(now: number): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        "DELETE FROM push_gateway_challenges WHERE expires_at < to_timestamp($1)",
        [now],
      );
      await client.query(
        "DELETE FROM push_gateway_delivery_auth_replays WHERE expires_at < to_timestamp($1)",
        [now],
      );
      await client.query(
        "DELETE FROM push_gateway_delivery_request_replays WHERE expires_at < to_timestamp($1)",
        [now],
      );
      await client.query(
        `DELETE FROM push_gateway_endpoint_quotas
         WHERE updated_at < to_timestamp($1) - interval '1 day'`,
        [now],
      );
      await client.query(
        `DELETE FROM push_gateway_delegations d
         WHERE d.expires_at < to_timestamp($1)
            OR d.revoked_at < to_timestamp($1) - interval '1 day'
            OR EXISTS (
              SELECT 1 FROM push_gateway_installations i
              WHERE i.id=d.installation_id
                AND (
                  i.expires_at < to_timestamp($1)
                  OR i.revoked_at < to_timestamp($1) - interval '1 day'
                )
            )`,
        [now],
      );
      await client.query(
        `DELETE FROM push_gateway_installations
         WHERE expires_at < to_timestamp($1)
            OR revoked_at < to_timestamp($1) - interval '1 day'`,
        [now],
      );
    });
  }

  async #query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    try {
      return await this.pool.query<T>(sql, [...parameters]);
    } catch {
      unavailable();
    }
  }

  async #transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      unavailable();
    }
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original error still carries the relevant rejection boundary.
      }
      if (error instanceof AuthorityError) throw error;
      unavailable();
    } finally {
      client.release();
    }
  }
}

type InstallationRow = {
  id: string;
  app_attest_key_id: Buffer;
  app_attest_public_key: Buffer;
  assertion_counter: string;
  app_profile: string;
  token_ciphertext: Buffer;
  token_fingerprint: Buffer;
  endpoint_epoch: string;
  expires_at_epoch: string;
  revoked_at: Date | null;
};

const TABLES = [
  "push_gateway_challenges",
  "push_gateway_installations",
  "push_gateway_delegations",
  "push_gateway_endpoint_quotas",
  "push_gateway_delivery_auth_replays",
  "push_gateway_delivery_request_replays",
] as const;

function installationFromRow(row: InstallationRow): Installation {
  return {
    appAttestKeyId: Buffer.from(row.app_attest_key_id),
    appAttestPublicKey: Buffer.from(row.app_attest_public_key),
    assertionCounter: integer(row.assertion_counter),
    endpointEpoch: integer(row.endpoint_epoch),
    expiresAt: integer(row.expires_at_epoch),
    id: row.id,
    profile: profile(row.app_profile),
    revoked: row.revoked_at !== null,
    tokenCiphertext: Buffer.from(row.token_ciphertext),
    tokenFingerprint: Buffer.from(row.token_fingerprint),
  };
}

function profile(value: string): AppProfile {
  try {
    return AppProfileSchema.parse(value);
  } catch {
    unavailable();
  }
}

function integer(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) unavailable();
  return parsed;
}

function reject(): never {
  throw new AuthorityError("rejected");
}

function unavailable(): never {
  throw new AuthorityError("unavailable");
}

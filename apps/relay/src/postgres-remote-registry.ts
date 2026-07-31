import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  mintEnrollmentToken,
  parseEnrollmentToken,
  RemoteProtocolError,
  remoteCapabilitySchema,
  type EnrollmentRecord,
  type MintedEnrollment,
} from "@buzz/remote-agent-protocol";

import {
  type RemoteRegistryContract,
  type RemoteWorkerBinding,
  validateApprovalEvent,
  validateEnrollmentEvent,
} from "./remote-registry.js";

const capabilitiesSchema = z.array(remoteCapabilitySchema).max(8);

type EnrollmentRow = {
  readonly id: string;
  readonly owner_pubkey: string;
  readonly community: string;
  readonly token_hash: Buffer;
  readonly capabilities: unknown;
  readonly expires_at: Date;
  readonly used_at: Date | null;
  readonly worker_pubkey: string | null;
  readonly enrollment_event_id: Buffer | null;
  readonly approved_at: Date | null;
  readonly revoked_at: Date | null;
};

/**
 * Durable BRAP registry.
 *
 * Every mutation resolves the tenant from the server-selected host and locks
 * the scoped enrollment row before changing it. No reusable bearer secret is
 * written to PostgreSQL.
 */
export class PostgresRemoteRegistry implements RemoteRegistryContract {
  public constructor(private readonly pool: Pool) {}

  public async mint(input: {
    readonly ownerPubkey: string;
    readonly community: string;
    readonly capabilities: readonly z.infer<typeof remoteCapabilitySchema>[];
    readonly lifetimeSeconds?: number;
    readonly now: number;
  }): Promise<MintedEnrollment> {
    const minted = mintEnrollmentToken(input);
    const result = await this.pool.query(
      `INSERT INTO remote_agent_enrollments (
         community_id, id, token_hash, owner_pubkey, capabilities, expires_at
       )
       SELECT c.id, $2::uuid, decode($3, 'hex'), $4, $5::jsonb,
              to_timestamp($6)
       FROM communities c
       WHERE lower(c.host) = lower($1) AND c.archived_at IS NULL
       RETURNING id`,
      [
        input.community,
        minted.record.id,
        minted.record.secretHash,
        input.ownerPubkey,
        JSON.stringify(minted.record.capabilities),
        minted.record.expiresAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new RemoteProtocolError(
        "ENROLLMENT_INVALID",
        "community is unavailable",
      );
    }
    return minted;
  }

  public async redeem(input: {
    readonly token: string;
    readonly event: unknown;
    readonly authenticatedPubkey: string;
    readonly community: string;
    readonly now: number;
  }): Promise<{
    readonly event: ReturnType<typeof validateEnrollmentEvent>;
    readonly binding: RemoteWorkerBinding;
  }> {
    return this.transaction(async (client) => {
      const tokenId = enrollmentIdFromToken(input.token);
      const row = await selectEnrollmentForUpdate(
        client,
        input.community,
        tokenId,
      );
      if (!row) {
        throw new RemoteProtocolError(
          "ENROLLMENT_INVALID",
          "enrollment invitation does not exist",
        );
      }
      const record = enrollmentRecord(row);
      const allowUsed =
        row.used_at !== null &&
        row.worker_pubkey === input.authenticatedPubkey &&
        row.revoked_at === null;
      const event = validateEnrollmentEvent(input, record, { allowUsed });

      if (row.used_at === null) {
        await client.query(
          `UPDATE remote_agent_enrollments e
           SET used_at = to_timestamp($4),
               worker_pubkey = $5,
               enrollment_event_id = decode($6, 'hex'),
               updated_at = now()
           FROM communities c
           WHERE e.community_id = c.id
             AND lower(c.host) = lower($1)
             AND e.id = $2::uuid
             AND e.token_hash = decode($3, 'hex')
             AND e.used_at IS NULL
             AND e.revoked_at IS NULL`,
          [
            input.community,
            row.id,
            row.token_hash.toString("hex"),
            input.now,
            input.authenticatedPubkey,
            event.id,
          ],
        );
      }

      return {
        binding: bindingFromRow({
          ...row,
          enrollment_event_id:
            row.enrollment_event_id ?? Buffer.from(event.id, "hex"),
          used_at: row.used_at ?? new Date(input.now * 1_000),
          worker_pubkey: row.worker_pubkey ?? input.authenticatedPubkey,
        }),
        event,
      };
    });
  }

  public async approve(input: {
    readonly enrollmentId: string;
    readonly workerPubkey: string;
    readonly authenticatedOwnerPubkey: string;
    readonly community: string;
    readonly event: unknown;
    readonly now: number;
  }): Promise<{
    readonly event: ReturnType<typeof validateApprovalEvent>;
    readonly binding: RemoteWorkerBinding;
  }> {
    return this.transaction(async (client) => {
      const result = await client.query<EnrollmentRow>(
        `${enrollmentSelect}
         WHERE lower(c.host) = lower($1)
           AND e.id = $2::uuid
           AND e.worker_pubkey = $3
           AND e.owner_pubkey = $4
           AND e.revoked_at IS NULL
         FOR UPDATE OF e`,
        [
          input.community,
          input.enrollmentId,
          input.workerPubkey,
          input.authenticatedOwnerPubkey,
        ],
      );
      const row = result.rows[0];
      if (!row || row.used_at === null) {
        throw new RemoteProtocolError(
          "OWNER_APPROVAL_REQUIRED",
          "pending worker enrollment was not found",
        );
      }
      const event = validateApprovalEvent(input);
      await client.query(
        `UPDATE remote_agent_enrollments
         SET approved_at = COALESCE(approved_at, to_timestamp($2)),
             approval_event_id = COALESCE(approval_event_id, decode($3, 'hex')),
             updated_at = now()
         WHERE community_id = (
           SELECT id FROM communities WHERE lower(host) = lower($4)
         ) AND id = $1::uuid AND revoked_at IS NULL`,
        [input.enrollmentId, input.now, event.id, input.community],
      );
      return {
        binding: bindingFromRow({
          ...row,
          approved_at: row.approved_at ?? new Date(input.now * 1_000),
        }),
        event,
      };
    });
  }

  public async authorizedWorker(
    workerPubkey: string,
    community: string,
  ): Promise<RemoteWorkerBinding | undefined> {
    const result = await this.pool.query<EnrollmentRow>(
      `${enrollmentSelect}
       WHERE lower(c.host) = lower($1)
         AND e.worker_pubkey = $2
         AND e.approved_at IS NOT NULL
         AND e.revoked_at IS NULL`,
      [community, workerPubkey],
    );
    const row = result.rows[0];
    return row ? bindingFromRow(row) : undefined;
  }

  public async workerBinding(
    workerPubkey: string,
    community: string,
  ): Promise<RemoteWorkerBinding | undefined> {
    const result = await this.pool.query<EnrollmentRow>(
      `${enrollmentSelect}
       WHERE lower(c.host) = lower($1) AND e.worker_pubkey = $2`,
      [community, workerPubkey],
    );
    const row = result.rows[0];
    return row ? bindingFromRow(row) : undefined;
  }

  public async revoke(input: {
    readonly workerPubkey: string;
    readonly authenticatedOwnerPubkey: string;
    readonly community: string;
    readonly now: number;
  }): Promise<RemoteWorkerBinding> {
    const result = await this.pool.query<EnrollmentRow>(
      `UPDATE remote_agent_enrollments e
       SET revoked_at = to_timestamp($4), updated_at = now()
       FROM communities c
       WHERE e.community_id = c.id
         AND lower(c.host) = lower($1)
         AND e.worker_pubkey = $2
         AND e.owner_pubkey = $3
         AND e.approved_at IS NOT NULL
         AND e.revoked_at IS NULL
       RETURNING e.id, e.owner_pubkey, c.host AS community, e.token_hash,
                 e.capabilities, e.expires_at, e.used_at, e.worker_pubkey,
                 e.enrollment_event_id, e.approved_at, e.revoked_at`,
      [
        input.community,
        input.workerPubkey,
        input.authenticatedOwnerPubkey,
        input.now,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "approved remote worker was not found",
      );
    }
    return bindingFromRow(row);
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw normalizeDatabaseError(error);
    } finally {
      client.release();
    }
  }
}

const enrollmentSelect = `SELECT e.id, e.owner_pubkey, c.host AS community,
  e.token_hash, e.capabilities, e.expires_at, e.used_at, e.worker_pubkey,
  e.enrollment_event_id, e.approved_at, e.revoked_at
  FROM remote_agent_enrollments e
  JOIN communities c ON c.id = e.community_id`;

async function selectEnrollmentForUpdate(
  client: PoolClient,
  community: string,
  enrollmentId: string,
): Promise<EnrollmentRow | undefined> {
  const result = await client.query<EnrollmentRow>(
    `${enrollmentSelect}
     WHERE lower(c.host) = lower($1) AND e.id = $2::uuid
     FOR UPDATE OF e`,
    [community, enrollmentId],
  );
  return result.rows[0];
}

function enrollmentIdFromToken(token: string): string {
  return parseEnrollmentToken(token).id;
}

function enrollmentRecord(row: EnrollmentRow): EnrollmentRecord {
  return {
    capabilities: capabilitiesSchema.parse(row.capabilities),
    community: row.community,
    expiresAt: Math.floor(row.expires_at.getTime() / 1_000),
    id: row.id,
    ownerPubkey: row.owner_pubkey,
    secretHash: row.token_hash.toString("hex"),
    ...(row.used_at
      ? { usedAt: Math.floor(row.used_at.getTime() / 1_000) }
      : {}),
  };
}

function bindingFromRow(row: EnrollmentRow): RemoteWorkerBinding {
  if (!row.worker_pubkey || !row.enrollment_event_id || !row.used_at) {
    throw new RemoteProtocolError(
      "ENROLLMENT_INVALID",
      "remote worker binding is incomplete",
    );
  }
  return {
    capabilities: capabilitiesSchema.parse(row.capabilities),
    community: row.community,
    enrollmentEventId: row.enrollment_event_id.toString("hex"),
    enrollmentId: row.id,
    ownerPubkey: row.owner_pubkey,
    workerPubkey: row.worker_pubkey,
    ...(row.approved_at
      ? { approvedAt: Math.floor(row.approved_at.getTime() / 1_000) }
      : {}),
    ...(row.revoked_at
      ? { revokedAt: Math.floor(row.revoked_at.getTime() / 1_000) }
      : {}),
  };
}

function normalizeDatabaseError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  ) {
    return new RemoteProtocolError(
      "ENROLLMENT_USED",
      "remote worker is already bound",
    );
  }
  return error instanceof RemoteProtocolError
    ? error
    : new RemoteProtocolError("CONFIG_INVALID", "database operation failed");
}

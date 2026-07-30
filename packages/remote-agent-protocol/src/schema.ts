import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_TAG = "brap/1" as const;
export const DEFAULT_COMMAND_LIFETIME_SECONDS = 30;
export const MAX_COMMAND_LIFETIME_SECONDS = 300;
export const MAX_CONTROL_PLAINTEXT_BYTES = 64 * 1024;
export const MAX_OUTER_EVENT_BYTES = 256 * 1024;
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
/**
 * How long a session's accepted sequence position is remembered after its most
 * recent accepted message. This is the protocol's replay window, not a single
 * command's lifetime: a session that idles must still demand the next sequence
 * rather than silently restarting at zero.
 */
export const SESSION_STATE_TTL_SECONDS = 15 * 60;

const uuidSchema = z.uuid();
const unixSecondsSchema = z.number().int().nonnegative();
const pubkeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const sessionIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const secretReferenceSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:env:\/\/[A-Z][A-Z0-9_]*|keyring:\/\/[A-Za-z0-9._/-]+|vault:\/\/[A-Za-z0-9._/-]+)$/,
    "must be an env://, keyring://, or vault:// secret reference",
  );

export const remoteCapabilities = [
  "deploy",
  "start",
  "stop",
  "restart",
  "update",
  "status",
  "logs",
  "revoke",
] as const;

export const remoteCapabilitySchema = z.enum(remoteCapabilities);

export const remoteDeploymentConfigSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128),
    systemPrompt: z
      .string()
      .max(32 * 1024)
      .optional(),
    runtimeId: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256).optional(),
    providerId: z.string().trim().min(1).max(128).optional(),
    idleTimeoutSeconds: z.number().int().min(10).max(604_800).optional(),
    maxTurnDurationSeconds: z.number().int().min(10).max(604_800).optional(),
    parallelism: z.number().int().min(1).max(32).optional(),
    respondTo: z
      .enum(["owner-only", "allowlist", "anyone", "nobody"])
      .optional(),
    respondToAllowlist: z.array(pubkeySchema).max(256).optional(),
    channelIds: z.array(uuidSchema).max(256).optional(),
    teamId: uuidSchema.optional(),
    personaId: z.string().trim().min(1).max(256).optional(),
    secretReferences: z
      .record(
        z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
        secretReferenceSchema,
      )
      .refine((value) => Object.keys(value).length <= 64, {
        message: "at most 64 secret references are allowed",
      })
      .optional(),
  })
  .strict();

const commonPayloadShape = {
  version: z.literal(PROTOCOL_VERSION),
  messageId: uuidSchema,
  deploymentId: uuidSchema,
  sessionId: sessionIdSchema,
  sequence: z.number().int().nonnegative(),
  issuedAt: unixSecondsSchema,
  expiresAt: unixSecondsSchema,
};

export const enrollmentPayloadSchema = z
  .object({
    ...commonPayloadShape,
    type: z.literal("enrollment"),
    body: z
      .object({
        enrollmentId: uuidSchema,
        workerName: z.string().trim().min(1).max(128),
        workerVersion: z.string().trim().min(1).max(64),
        workerPubkey: pubkeySchema,
        ownerPubkey: pubkeySchema,
        community: z.string().trim().min(1).max(253),
        capabilities: z.array(remoteCapabilitySchema).max(32),
        challenge: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

export const commandPayloadSchema = z
  .object({
    ...commonPayloadShape,
    type: z.literal("command"),
    body: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("deploy"),
          config: remoteDeploymentConfigSchema,
        })
        .strict(),
      z.object({ action: z.literal("start") }).strict(),
      z.object({ action: z.literal("stop") }).strict(),
      z.object({ action: z.literal("restart") }).strict(),
      z
        .object({
          action: z.literal("update"),
          config: remoteDeploymentConfigSchema,
        })
        .strict(),
      z.object({ action: z.literal("status") }).strict(),
      z
        .object({
          action: z.literal("logs"),
          lines: z.number().int().min(1).max(2_000).default(200),
        })
        .strict(),
      z
        .object({
          action: z.literal("revoke"),
          eraseAgentKey: z.boolean(),
          destructiveConfirmation: z
            .literal("ERASE_REMOTE_AGENT_KEY")
            .optional(),
        })
        .strict()
        .refine(
          (value) =>
            !value.eraseAgentKey ||
            value.destructiveConfirmation === "ERASE_REMOTE_AGENT_KEY",
          {
            message: "erasing the agent key requires destructiveConfirmation",
          },
        ),
    ]),
  })
  .strict();

export const statusPayloadSchema = z
  .object({
    ...commonPayloadShape,
    type: z.literal("status"),
    body: z
      .object({
        state: z.enum([
          "hello",
          "deploying",
          "running",
          "stopping",
          "stopped",
          "failed",
          "revoked",
        ]),
        workerVersion: z.string().trim().min(1).max(64),
        capabilities: z.array(remoteCapabilitySchema).max(32).optional(),
        challenge: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        detail: z.string().max(2_048).optional(),
      })
      .strict(),
  })
  .strict();

export const ackPayloadSchema = z
  .object({
    ...commonPayloadShape,
    type: z.literal("ack"),
    body: z
      .object({
        commandMessageId: uuidSchema,
        outcome: z.enum(["accepted", "completed", "rejected"]),
        code: z.string().trim().min(1).max(64).optional(),
        message: z
          .string()
          .max(48 * 1024)
          .optional(),
        challenge: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        agentPubkey: pubkeySchema.optional(),
      })
      .strict(),
  })
  .strict();

export const remotePayloadSchema = z.discriminatedUnion("type", [
  enrollmentPayloadSchema,
  commandPayloadSchema,
  statusPayloadSchema,
  ackPayloadSchema,
]);

export type RemoteCapability = z.infer<typeof remoteCapabilitySchema>;
export type RemoteDeploymentConfig = z.infer<
  typeof remoteDeploymentConfigSchema
>;
export type EnrollmentPayload = z.infer<typeof enrollmentPayloadSchema>;
export type CommandPayload = z.infer<typeof commandPayloadSchema>;
export type StatusPayload = z.infer<typeof statusPayloadSchema>;
export type AckPayload = z.infer<typeof ackPayloadSchema>;
export type RemotePayload = z.infer<typeof remotePayloadSchema>;

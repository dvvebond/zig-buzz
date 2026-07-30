import { z } from "zod";

export const MAX_REQUEST_BYTES = 8 * 1_024;
export const MAX_GRANT_BYTES = 4_096;
export const MAX_ENDPOINT_HEX_BYTES = 512;
export const WIRE_VERSION = 1;
export const APNS_RECONNECT_PAYLOAD = Buffer.from(
  '{"aps":{"alert":{"body":"Reconnect to your relay now"},"mutable-content":1}}',
);

export const AppProfileSchema = z.enum([
  "buzz-ios-production",
  "buzz-ios-sandbox",
]);
export type AppProfile = z.infer<typeof AppProfileSchema>;

const UuidSchema = z.uuid();
const PositiveInteger = z.number().int().positive().safe();
const Timestamp = z.number().int().safe();
const Version = z.literal(WIRE_VERSION);
const ChallengeFields = {
  challenge: z.string().min(1).max(128),
  challenge_id: UuidSchema,
} as const;
const InstallationFields = {
  installation_handle: UuidSchema,
} as const;
const Assertion = z.string().min(1).max(1_368);

export const InstallationChallengeRequestSchema = z
  .object({ v: Version })
  .strict();
export const InstallationEnrollRequestSchema = z
  .object({
    app_profile: AppProfileSchema,
    attestation: z.string().min(1).max(22_000),
    ...ChallengeFields,
    endpoint: z
      .string()
      .min(2)
      .max(MAX_ENDPOINT_HEX_BYTES * 2),
    endpoint_epoch: z.literal(1),
    expires_at: Timestamp,
    key_id: z.string().min(1).max(256),
    v: Version,
  })
  .strict();
export const DelegationRequestSchema = z
  .object({
    assertion: Assertion,
    ...ChallengeFields,
    endpoint_epoch: PositiveInteger,
    expires_at: Timestamp,
    generation: PositiveInteger,
    ...InstallationFields,
    not_before: Timestamp,
    relay_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    v: Version,
  })
  .strict();
export const RotateEndpointRequestSchema = z
  .object({
    assertion: Assertion,
    ...ChallengeFields,
    endpoint: z
      .string()
      .min(2)
      .max(MAX_ENDPOINT_HEX_BYTES * 2),
    endpoint_epoch: PositiveInteger,
    ...InstallationFields,
    new_endpoint_epoch: PositiveInteger,
    v: Version,
  })
  .strict();
export const RevokeDelegationRequestSchema = z
  .object({
    assertion: Assertion,
    ...ChallengeFields,
    generation: PositiveInteger,
    ...InstallationFields,
    relay_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    v: Version,
  })
  .strict();
export const RevokeInstallationRequestSchema = z
  .object({
    assertion: Assertion,
    ...ChallengeFields,
    endpoint_epoch: PositiveInteger,
    ...InstallationFields,
    new_endpoint_epoch: PositiveInteger,
    v: Version,
  })
  .strict();
export const DeliveryRequestSchema = z
  .object({
    endpoint_grant: z.string().min(1).max(MAX_GRANT_BYTES),
    expires_at: Timestamp,
    request_id: UuidSchema,
    v: Version,
  })
  .strict();
export const EndpointGrantSchema = z
  .object({
    app_profile: AppProfileSchema,
    delegation_id: UuidSchema,
    endpoint_epoch: PositiveInteger,
    expires_at: Timestamp,
    generation: PositiveInteger,
    relay_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    v: Version,
  })
  .strict();

export type EndpointGrant = z.infer<typeof EndpointGrantSchema>;
export type InstallationEnrollRequest = z.infer<
  typeof InstallationEnrollRequestSchema
>;
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;
export type RotateEndpointRequest = z.infer<typeof RotateEndpointRequestSchema>;
export type RevokeDelegationRequest = z.infer<
  typeof RevokeDelegationRequestSchema
>;
export type RevokeInstallationRequest = z.infer<
  typeof RevokeInstallationRequestSchema
>;
export type DeliveryRequest = z.infer<typeof DeliveryRequestSchema>;

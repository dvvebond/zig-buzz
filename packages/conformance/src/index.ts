import { z } from "zod";

export const TRACE_SCHEMA_VERSION = 1;
const Label = z.string().min(1).max(255);
// Conformance fixtures use structurally UUID-shaped labels without requiring
// an RFC version/variant nibble.
const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const Community = Uuid;
const Channel = Uuid;
const OptionalCommunity = Community.nullable().optional();
const StateSchema = z
  .object({
    resolved_community: Community,
    bound_host: Label,
    actor: Label,
  })
  .strict();
const ReadActionFields = {
  channel: Channel.nullable().optional(),
  row_communities: z.array(Community).max(100_000),
};
export const TraceActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("write_insert"),
      msg_id: Label,
      channel: Channel,
      claimed_community: OptionalCommunity,
    })
    .strict(),
  z
    .object({
      type: z.literal("write_insert_global"),
      msg_id: Label,
      claimed_community: OptionalCommunity,
    })
    .strict(),
  z
    .object({
      type: z.literal("write_duplicate"),
      msg_id: Label,
      channel: Channel,
      claimed_community: OptionalCommunity,
    })
    .strict(),
  z
    .object({
      type: z.literal("sanitized_error"),
      reason: z.enum(["restricted", "invalid", "server_error"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("auth_check"),
      channel: Channel,
      claimed_community: OptionalCommunity,
      verdict: z.enum(["allow", "deny"]),
    })
    .strict(),
  z
    .object({ type: z.literal("read_message_rows"), ...ReadActionFields })
    .strict(),
  z
    .object({ type: z.literal("read_by_id_rows"), ...ReadActionFields })
    .strict(),
  z
    .object({
      type: z.literal("read_host_feed_rows"),
      row_communities: z.array(Community).max(100_000),
    })
    .strict(),
  z.object({ type: z.literal("impl_bug"), kind: Label }).strict(),
]);
export type TraceAction = z.infer<typeof TraceActionSchema>;
export const TraceStepSchema = z
  .object({
    schema_version: z.number().int(),
    action: TraceActionSchema,
    state_after: StateSchema,
  })
  .strict();
export type TraceStep = z.infer<typeof TraceStepSchema>;

export type ConformanceFailureKind =
  | "illegal_transition"
  | "state_mismatch"
  | "non_interference"
  | "coverage_breach";

export class ConformanceError extends Error {
  public constructor(
    public readonly kind: ConformanceFailureKind,
    message: string,
    public readonly stepIndex?: number,
  ) {
    super(message);
    this.name = "ConformanceError";
  }
}

export interface Scenario {
  readonly trace: readonly TraceStep[];
  readonly requiredCriticalActions?: ReadonlySet<string>;
}

/**
 * Independent replay checker for docs/spec/MultiTenantRelay.tla.
 * It intentionally imports no relay production helpers.
 */
export function checkTrace(scenario: Scenario): void {
  if (scenario.trace.length === 0) {
    throw new ConformanceError(
      "coverage_breach",
      "trace is empty: seam reached without an emitted action",
    );
  }
  const first = TraceStepSchema.parse(scenario.trace[0]);
  requireSchema(first, 0);
  const model = first.state_after;
  const seen = new Set<string>();
  for (const [index, unparsed] of scenario.trace.entries()) {
    const step = TraceStepSchema.parse(unparsed);
    requireSchema(step, index);
    if (step.state_after.resolved_community !== model.resolved_community) {
      fail("state_mismatch", index, "resolved community changed mid-request");
    }
    if (step.state_after.bound_host !== model.bound_host) {
      fail("state_mismatch", index, "bound host changed mid-request");
    }
    if (step.state_after.actor !== model.actor) {
      fail("state_mismatch", index, "actor changed mid-request");
    }
    const action = step.action;
    seen.add(action.type);
    switch (action.type) {
      case "auth_check":
        if (
          action.verdict === "allow" &&
          action.claimed_community != null &&
          action.claimed_community !== model.resolved_community
        ) {
          fail(
            "illegal_transition",
            index,
            "allow verdict used a foreign claimed community",
          );
        }
        break;
      case "read_message_rows":
      case "read_by_id_rows":
      case "read_host_feed_rows": {
        const foreign = action.row_communities.find(
          (community) => community !== model.resolved_community,
        );
        if (foreign) {
          fail(
            "non_interference",
            index,
            `row labeled ${foreign} escaped tenant ${model.resolved_community}`,
          );
        }
        break;
      }
      case "impl_bug":
        throw new ConformanceError(
          "coverage_breach",
          `implementation seam exited without trace: ${action.kind}`,
          index,
        );
      default:
        break;
    }
  }
  const missing = [...(scenario.requiredCriticalActions ?? [])]
    .filter((kind) => !seen.has(kind))
    .sort();
  if (missing.length > 0) {
    throw new ConformanceError(
      "coverage_breach",
      `required actions never emitted: ${missing.join(", ")}`,
    );
  }
}

export function parseJsonLines(input: string): TraceStep[] {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return TraceStepSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `invalid trace JSONL line ${index + 1}: ${String(error)}`,
        );
      }
    });
}

function requireSchema(step: TraceStep, index: number): void {
  if (step.schema_version !== TRACE_SCHEMA_VERSION) {
    fail(
      "illegal_transition",
      index,
      `schema ${step.schema_version} does not match ${TRACE_SCHEMA_VERSION}`,
    );
  }
}

function fail(
  kind: Exclude<ConformanceFailureKind, "coverage_breach">,
  index: number,
  message: string,
): never {
  throw new ConformanceError(kind, message, index);
}

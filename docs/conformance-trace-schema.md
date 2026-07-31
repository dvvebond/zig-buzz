# Trace Schema (`@buzz/conformance`)

Schema version: **1** (`TRACE_SCHEMA_VERSION` in
`packages/conformance/src/index.ts`).

This is the JSONL contract between a relay trace emitter and the independent
TypeScript replay checker. It is grounded in
`docs/spec/MultiTenantRelay.tla`. A schema change must update this document,
the strict parser, and the committed fixtures in the same change.

## Trace step

```jsonc
{
  "schema": 1,
  "action": { "type": "auth_check" },
  "state": {
    "resolved_community": "<uuid>",
    "bound_host": "<normalized host>",
    "actor": "<16 lowercase hex>"
  }
}
```

The state is a bounded projection. It never contains private keys,
authorization tokens, signatures, payloads, raw headers, or decrypted
content.

## Actions

Write actions:

- `write_insert { msg_id, channel, claimed_community }`
- `write_insert_global { msg_id, claimed_community }`
- `write_duplicate { msg_id, channel, claimed_community }`

Read and authorization actions:

- `auth_check { channel, claimed_community, verdict }`
- `read_message_rows { channel, row_communities }`
- `read_by_id_rows { channel, row_communities }`
- `read_host_feed_rows { row_communities }`

Failure/coverage actions:

- `sanitized_error { reason }`, where reason is `restricted`, `invalid`, or
  `server_error`;
- `impl_bug { kind }`, a coverage-breach witness that always fails replay.

## Projection rules

1. Keep `claimed_community` separate from `resolved_community`. The checker
   must see a disagreement rather than normalizing it away.
2. Keep `row_communities` as an unfiltered array. Every returned row label,
   including duplicates and foreign labels, is observable.
3. Keep sanitized reasons a closed union so a new internal error category
   cannot silently leak through a generic string.
4. Do not reuse a trace across requests, actors, hosts, or communities.

## Implementation

`packages/conformance/src/index.ts` contains the strict schema parser,
transition replay, non-interference checks, and typed errors.
`packages/conformance/tests/fixtures` contains reviewable good and
mutation-class bad traces. The relay integration suite owns emitter coverage.

`checkTrace` fails with:

- `IllegalTransition` for an action not permitted by the modeled state;
- `StateMismatch` when host, community, or actor changes within a trace;
- `NonInterference` for a foreign row-community label;
- `CoverageBreach` for an empty/incomplete trace or `impl_bug`.

Run:

```bash
pnpm --filter @buzz/conformance check
BUZZ_RUN_INTEGRATION=1 pnpm --filter @buzz/relay test
```

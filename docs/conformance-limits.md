# Limits of the runtime conformance gate

The checker in `packages/conformance` is an executable safety oracle, not a
formal proof. It accepts or rejects the concrete JSONL traces supplied to it.
A green run therefore means only that the executions represented by those
traces obeyed the modeled tenant-isolation transitions.

## What it covers

- host/community binding remains stable through a trace;
- channel authorization cannot be granted across communities;
- returned row-community labels remain confined to the resolved community;
- write claims agree with the server-resolved community;
- critical seams do not emit `impl_bug` coverage-breach witnesses;
- malformed, empty, and scenario-incomplete traces fail closed.

The relay owns the production authorization and query decisions. The
conformance package independently replays their bounded projections; it is
observation-only and never changes a production decision.

## What it cannot prove

- Unexecuted paths are not covered. A new endpoint that emits no trace is
  invisible unless its scenario requires an action or records `impl_bug`.
- A projection that lies or omits a leaked row can make unsafe behavior appear
  safe. Emitters must record raw row-community labels before filtering.
- One-process traces do not by themselves prove cross-pod replay, Redis fan-out,
  object-store, or timing properties.
- The untimed model does not replace load, race, fault-injection, or
  adversarial integration tests.
- The checker and model can share a specification mistake. The TLA+ model in
  `docs/spec/MultiTenantRelay.tla` remains the formal reference.

## Required gate

Run the complete TypeScript package suite:

```bash
pnpm --filter @buzz/conformance check
```

The replay fixtures live in `packages/conformance/tests/fixtures`:

- `good.jsonl` must pass;
- `bad_host_channel_mismatch.jsonl` must fail with an illegal transition;
- `bad_foreign_row_leak.jsonl` must fail non-interference;
- `bad_coverage_breach.jsonl` must fail coverage.

Relay integration tests separately exercise the emitting network and
persistence paths:

```bash
BUZZ_RUN_INTEGRATION=1 pnpm --filter @buzz/relay test
```

Both gates are required. Fixture replay proves the checker bites; relay
integration proves the running implementation reaches the expected seams.

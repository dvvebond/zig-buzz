# Releasing Buzz

Buzz has independent TypeScript release lanes:

| Lane | Version source | Artifact |
| --- | --- | --- |
| Desktop | `desktop/package.json` | platform-labelled TypeScript desktop archive |
| Relay | `apps/relay/package.json` | `ghcr.io/block/buzz` container |
| Mobile | exact `mobile-vX.Y.Z-rc.N` tag | Expo/EAS iOS and Android builds |
| Sprig | `apps/sprig/package.json` | deployable agent archive |
| Push gateway | `apps/push-gateway/package.json` | container |

## Pre-release gate

Use a clean checkout and run:

```bash
pnpm install --frozen-lockfile
just ci
just test
pnpm build
pnpm package:desktop:archive
pnpm --filter @buzz/mobile build
pnpm --filter @buzz/mobile doctor
```

Build and smoke the affected containers from the exact release commit. Do not
publish from uncommitted source or reuse a development artifact.

## Desktop

Update the package version:

```bash
just bump-desktop-version 0.5.0
pnpm install --lockfile-only
pnpm package:desktop:archive
```

A `vX.Y.Z` tag triggers `.github/workflows/release.yml`. It builds the
TypeScript distribution for macOS arm64/x64, Linux x64, and Windows x64,
attests each archive, creates checksums, and uploads them to the GitHub release.

The archive contains the desktop host, React assets, production dependencies,
launchers, the remote-agent worker, metadata, and a SHA-256 manifest. It
requires the declared Node runtime on the destination.

## Relay

Update `apps/relay/package.json`:

```bash
just bump-relay-version 0.3.0
pnpm install --lockfile-only
just release-relay
```

Relay tags use `relay-vX.Y.Z`. `.github/workflows/docker.yml` builds the
multi-stage TypeScript image, runs its release checks, publishes immutable
version/SHA tags, and updates aliases only for stable releases. The runtime
image runs as an unprivileged user and contains the relay, admin CLI,
pair-relay, migrations, and built web/admin assets.

## Mobile

Mobile publication uses immutable candidates from remote canonical `main`:

```bash
scripts/mobile-release.sh candidate 0.5.0
```

The script:

1. requires a clean tree and canonical `block/buzz` origin;
2. resolves the exact current remote `main` commit;
3. derives the next exact `mobile-vX.Y.Z-rc.N` number;
4. dispatches the reviewed GitHub workflow;
5. has the release GitHub App create an annotated immutable tag;
6. waits and verifies that the tag resolves to the requested commit.

There is no mobile release branch, movable stable alias, source finalization,
or GitHub Release. The private mobile pipeline builds the exact candidate tag
with Expo/EAS, supplies monotonically increasing platform build numbers, signs
the native artifacts, and records the tag used for each platform.

The marketing version is synchronized between:

- `apps/mobile/package.json`;
- `apps/mobile/app.json` (`expo.version`).

The release contract test rejects a mismatch:

```bash
scripts/test-mobile-release-contract.sh
scripts/test-mobile-release-candidate-publisher.sh
```

## Sprig and remote workers

Build a deployable agent archive:

```bash
scripts/build-sprig.sh
```

The archive is a production pnpm deployment containing the multicall Sprig
entrypoint and agent/ACP/CLI/tool dependencies. The remote worker is packaged
with desktop distributions and may also be deployed directly from
`apps/remote-agent`.

Before publishing, run the BRAP gates:

```bash
pnpm --filter @buzz/remote-agent-protocol check
pnpm --filter @buzz/remote-agent-client check
pnpm --filter @buzz/remote-agent check
pnpm --filter @buzz/relay test
```

Never embed enrollment tokens, worker keys, agent keys, or provider credentials
in an artifact. Operators supply one-time enrollment at runtime; provider
secrets stay on the worker behind named secret references.

## Canaries and retries

Manual canary workflows build the same TypeScript source and are not release
authorities. Manual release dispatch is a retry for an immutable tag, not a way
to select arbitrary source.

For mobile, the candidate tag is the only accepted source identity. For
desktop and relay, verify the workflow checkout commit matches the tag before
publishing.

## Provenance

Every published archive or container should retain:

- source commit and immutable tag;
- package version;
- dependency lockfile digest;
- platform/runtime label;
- SHA-256 checksums;
- build provenance attestation;
- test and smoke-gate result.

Do not promote by rebuilding from a branch. Promote the already-tested artifact
whose provenance matches the approved source.

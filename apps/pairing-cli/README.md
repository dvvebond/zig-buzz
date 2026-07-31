# buzz-pair

TypeScript CLI tool for testing the [NIP-AB device pairing protocol](../../docs/spec/NIP-AB.md) end-to-end. It exercises the full protocol over a live Nostr relay and is intended for interoperability testing.

## Quick Start

```bash
pnpm --filter @buzz/pairing-cli build

# Terminal 1 — source (holds the secret)
pnpm --filter @buzz/pairing-cli exec buzz-pair source --relay ws://127.0.0.1:5000/pair

# Terminal 2 — target (receives the secret)
pnpm --filter @buzz/pairing-cli exec buzz-pair target --show-secret
# paste the QR URI from terminal 1 when prompted
```

Both sides display a 6-digit SAS code. Confirm they match on each side, and the key transfers.

## Subcommands

### `source`

Acts as the device holding the secret. Generates an ephemeral keypair and session secret, displays a `nostrpair://` QR URI, waits for a target to connect, performs SAS verification, and sends the payload.

```
buzz-pair source --relay <RELAY_URL> [--type nsec|bunker|connect|custom] [--payload-env NAME|--payload-file PATH]
```

- `--relay` — WebSocket relay URL (default: `ws://127.0.0.1:5000/pair`)
- `--type` — payload type (default: `nsec`)
- `--payload-env` / `--payload-file` — safe payload inputs. `--nsec` exists for interoperability but may expose the value through process listings. If no nsec is supplied, a throwaway test key is generated.

### `target`

Acts as the receiving device. Reads a `nostrpair://` URI from stdin, connects to the relay encoded in the URI, sends an offer, verifies SAS, and receives the payload.

```
buzz-pair target [--relay <OVERRIDE_URL>] [--show-secret]
```

- `--relay` — Override the relay URL from the QR code
- `--show-secret` — Print the received secret to stdout (off by default for safety)

### `test-vectors`

Prints all derived cryptographic values from the NIP-AB spec's fixed test keys. Useful for verifying implementations against the spec.

```
buzz-pair test-vectors
```

## Testing Against a Local Buzz Relay

The CLI supports NIP-42 authentication, so it works with Buzz relays out of the box.

### Prerequisites

- Node.js 22+ and pnpm 11+
- Workspace dependencies installed with `pnpm install --frozen-lockfile`

### Start the relay

```bash
pnpm --filter @buzz/pair-relay build
pnpm --filter @buzz/pair-relay start
```

### Run the E2E test

The package includes an automated in-memory protocol/relay integration suite:

```bash
pnpm --filter @buzz/pairing-cli check
```

It proves successful transfer plus SAS rejection without exposing a durable identity to the pairing relay.

### Manual two-terminal test

```bash
# Terminal 1
pnpm --filter @buzz/pairing-cli exec buzz-pair source --relay ws://127.0.0.1:5000/pair

# Terminal 2
pnpm --filter @buzz/pairing-cli exec buzz-pair target --show-secret
# paste the nostrpair:// URI, confirm SAS on both sides
```

## Protocol Overview

```
Source                          Relay                    Target
──────                          ─────                    ──────
Generate ephemeral keys
Display QR (pubkey+secret+relay)
Subscribe kind:24134                                     Scan QR
                                                         Generate ephemeral keys
                                                         Subscribe kind:24134
                                                         Wait for EOSE
                                ◄─────────────────────── Send offer
Verify session_id
Compute SAS ◄──────────────────────────────────────────► Compute SAS
Display: "047291"                                        Display: "047291"

[User confirms codes match]

Send sas-confirm ──────────────►─────────────────────►
                                                         Verify transcript_hash
                                                         [User confirms]
Send payload ──────────────────►─────────────────────►
                                                         Decrypt + import
                                ◄─────────────────────── Send complete
Done                                                     Done
```

All events are NIP-44 encrypted, signed with ephemeral keys, and addressed via `p` tags. The relay sees only opaque ciphertext between throwaway pubkeys.

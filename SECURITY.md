# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in Buzz, please report it by emailing
**buzz@block.xyz**. Include as much detail as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if available)
- The affected version(s) or commit range
- Any suggested mitigations you've identified

You will receive an acknowledgment within **48 hours**. We aim to provide a
full response — including a timeline for a fix — within **7 days** of initial
contact. We'll keep you informed as we work toward a resolution.

We ask that you:

- Give us reasonable time to address the issue before any public disclosure
- Avoid accessing or modifying data that does not belong to you
- Not perform denial-of-service attacks or disrupt production systems

We will credit reporters in release notes unless you prefer to remain anonymous.

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ Active |
| Previous releases | ⚠️ Best-effort; upgrade recommended |

Buzz is pre-1.0. We do not maintain long-term support branches at this stage.
All security fixes land on `main` first.

---

## Security Design Principles

### Authentication — NIP-42

Every connection to the relay must authenticate via
[NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md)
challenge/response before writing events. The relay sends a random challenge;
the client signs a `kind:22242` event containing the challenge and the relay
URL, proving possession of the private key.

REST endpoints authenticate via
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) HTTP Auth —
the client signs a `kind:27235` event containing the request URL and method.
The relay verifies the Schnorr signature and extracts the pubkey.

### Authorization — Membership, Roles, and Capabilities

Channel membership is the primary collaboration boundary. Roles control
administration and moderation, owner attestations bind managed identities, and
narrow capabilities govern operational surfaces such as remote-agent control.
Authentication alone never grants access.

Private channels are invisible to non-members: they do not appear in channel
listings, and subscription filters for private channel events return nothing
unless the subscriber is a member.

### Append-Only Audit Log

All events are written to a tamper-evident audit log (`buzz-audit`). Each
log entry is chained to the previous one via a SHA-256 hash chain. Because the
chain is keyless, it is tamper-evident but not tamper-resistant: it detects
accidental corruption or single-row edits, but an attacker with database write
access can recompute the entire chain after editing. The audit log is designed
for SOX-grade compliance and eDiscovery.

### Desktop and Worker Secret Storage

The desktop host and remote worker keep private keys in their secure local
store. Filesystem fallback is owner-only and encrypted; identity and provider
secrets are never exposed to the React client, relay, status payloads, or
ordinary logs. Mobile keys use Expo SecureStore.

Remote deployments accept named local secret references such as
`env://ANTHROPIC_API_KEY`, never raw provider credentials in a management
command. Worker and per-deployment agent keys are generated on the worker and
are not exportable.

### Remote Agent Control

BRAP v1 uses one outbound `wss://` connection from the worker to the ordinary
relay. It combines NIP-42 transport authentication with signed NIP-44 v2
control frames, one-time hashed enrollment, explicit fingerprint approval,
relay pinning, strict recipient/session/sequence/expiry binding, replay
rejection, capability-scoped commands, revocation, and a local kill switch.
There is no generic remote shell command or inbound worker listener. See
[`docs/remote-agent-protocol.md`](docs/remote-agent-protocol.md).

### Input Validation

- All UUIDs (channel IDs, workflow IDs) are validated at API boundaries before
  use in database queries.
- Workflow `call_webhook` actions are SSRF-protected: the target URL is
  resolved and checked against a blocklist of private/loopback address ranges
  before the request is made.
- Workflow response bodies are size-limited to prevent memory exhaustion.
- Workflow condition evaluation uses an explicit function environment and
  bounded execution.
- Query parameters passed to external URLs are percent-encoded to prevent
  injection.

### Transport Security

All production deployments must terminate TLS at the relay or a trusted reverse
proxy. Clients and remote workers reject insecure non-loopback relay URLs.

### Dependency Management

The lockfile is immutable in CI, Renovate isolates dependency changes, GitHub
dependency review checks pull requests, and the workspace runs package audits
and secret scanning. Production containers install only their filtered pnpm
dependency graph and run as an unprivileged user.

---

## Disclosure Policy

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).
Once a fix is ready and released, we will publish a security advisory on
GitHub describing the vulnerability, its impact, and the fix. Reporters will
be credited unless they request anonymity.

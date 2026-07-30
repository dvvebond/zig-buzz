# Remote agent operations

## The short version

The remote server needs Node.js 22+, the `buzz-remote-agent` executable, the
normal Buzz ACP harness, and whichever allowlisted runtime the agent uses. It
does not need an inbound firewall rule, an SSH credential from Buzz, or a
public HTTP endpoint.

In Buzz:

1. Add an agent and select **A remote server** under **Run on**.
2. Select **Create connection**.
3. Copy the displayed command and run it once on the remote server.
4. Compare the full worker fingerprint shown by Buzz with the worker you
   started, then select **Approve this server**.
5. Wait for **Remote server ready**, finish the agent form, and create it.

The one-time command contains an enrollment bearer token. Treat it like a
password until it expires or is redeemed. Do not put it in shell history,
service files, screenshots, tickets, or normal logs.

## Build and install

From a verified Buzz source checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @buzz/remote-agent build
pnpm --filter @buzz/remote-agent deploy --prod /opt/buzz-remote-agent
chmod 0755 /opt/buzz-remote-agent/dist/main.js
ln -s /opt/buzz-remote-agent/dist/main.js /usr/local/bin/buzz-remote-agent
```

A packaged release should be verified against its published checksum or
signature before installation.

Run the enrollment command copied from Buzz as the dedicated service user. The
worker writes an AES-256-GCM encrypted state file and a separate mode-0600
state key under `~/.config/buzz/remote-agent` by default. Back up both files
together or neither; losing the state key makes the state intentionally
unrecoverable.

After Buzz reports that the worker is approved, remove the enrollment token
from the shell history. Subsequent starts need only:

```bash
buzz-remote-agent --relay 'wss://buzz.example.com/'
```

## Service installation

Create a dedicated unprivileged `buzz-agent` user, install
`deploy/systemd/buzz-remote-agent.service`, and set the relay URL in
`/etc/buzz/remote-agent.env`:

```text
BUZZ_RELAY_URL=wss://buzz.example.com/
```

Do not put the enrollment token in that file. Enroll once interactively, then
enable the service:

```bash
systemctl daemon-reload
systemctl enable --now buzz-remote-agent
```

Provider credentials stay on the remote host. Configure them in the service
environment or an operator-managed secret store and refer to them from an
agent definition as `env://NAME`. BRAP rejects literal secret values.

## Network policy

Allow outbound TCP 443 and DNS to the Buzz relay. Deny unsolicited inbound
traffic unless another application on the server needs it. The worker makes
one `wss://` connection, authenticates with NIP-42, and carries enrollment,
session establishment, encrypted commands, status, and acknowledgements over
that socket.

TLS inspection changes the trust boundary. If an organization terminates TLS
in a proxy, the host's CA configuration must deliberately trust that proxy.
End-to-end NIP-44 encryption still hides control plaintext from the relay and
proxy, but they retain traffic metadata and availability control.

## Revocation

Use **Revoke access** before deleting the local definition. Online revocation
cuts off the relay binding immediately and sends the encrypted local-stop/key
erase instruction. Offline revocation still cuts off relay authorization; the
server operator must erase the disconnected worker's state locally.

To trust that host again after revocation, remove the old worker data directory
and perform a new enrollment. Revocation is deliberately not reversible by
reusing the old token or key.

## Troubleshooting

- `remote relay connections require wss://`: use TLS; `ws://` is accepted only
  for explicitly enabled loopback development.
- `worker enrollment is incomplete`: rerun the original one-time command while
  it is still valid and pending owner approval.
- `remote worker has not completed its secure session hello`: keep the worker
  online until Buzz shows **Remote server ready**.
- `runtime ... is not allowlisted`: install and select one of the worker's
  explicit runtimes; arbitrary commands are not accepted.
- `SECRET_REFERENCE_MISSING`: define the referenced secret on the remote host.
- Clock or expiry errors: synchronize both hosts with a trusted time source.

Worker logs are local. BRAP log requests return at most 2,000 lines and 48 KiB,
after redaction. Protocol errors never include enrollment tokens, private keys,
environment values, ciphertext, or raw child-process stderr.

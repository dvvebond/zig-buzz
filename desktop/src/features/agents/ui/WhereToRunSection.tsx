import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import * as React from "react";

import { useBackendProvidersQuery } from "@/features/agents/hooks";
import { probeBackendProvider } from "@/shared/api/tauri";
import {
  approveRemoteEnrollment,
  beginRemoteEnrollment,
  subscribeRemoteAgentEvents,
} from "@/features/agents/remote/remoteAgentController";
import { Button } from "@/shared/ui/button";

import { CopyButton } from "./CopyButton";
import { ProviderConfigFields } from "./ProviderConfigFields";
import { emptyWhereToRunDraft, type WhereToRunDraft } from "./whereToRunIntent";

/** Optional remote-backend selector. Buzz shared compute is an LLM provider, not a run destination. */
export function WhereToRunSection({
  draft,
  isPending,
  onDraftChange,
}: {
  draft: WhereToRunDraft;
  isPending: boolean;
  onDraftChange: (next: WhereToRunDraft) => void;
}) {
  const backendProviders = useBackendProvidersQuery().data ?? [];
  const [probeError, setProbeError] = React.useState<string | null>(null);
  const [remoteError, setRemoteError] = React.useState<string | null>(null);
  const [remoteAction, setRemoteAction] = React.useState<
    "creating" | "approving" | null
  >(null);
  const isRemoteMode = draft.runOn === "remote-server";
  const isProviderMode = draft.runOn !== "local" && !isRemoteMode;
  const selectedBackendProvider = React.useMemo(
    () =>
      backendProviders.find((provider) => provider.id === draft.runOn) ?? null,
    [backendProviders, draft.runOn],
  );

  React.useEffect(() => {
    if (!isProviderMode || !selectedBackendProvider) {
      setProbeError(null);
      return;
    }
    let cancelled = false;
    setProbeError(null);
    void probeBackendProvider(selectedBackendProvider.binaryPath)
      .then((result) => {
        if (cancelled) return;
        const defaults: Record<string, string> = {};
        const properties =
          (result.config_schema as Record<string, unknown> | undefined)
            ?.properties ?? {};
        for (const [key, property] of Object.entries(properties) as [
          string,
          Record<string, unknown>,
        ][]) {
          if (property.default != null)
            defaults[key] = String(property.default);
        }
        onDraftChange({
          ...draft,
          probedProvider: result,
          providerConfig: defaults,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProbeError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [draft, isProviderMode, onDraftChange, selectedBackendProvider]);

  React.useEffect(() => {
    if (!isRemoteMode || !draft.remote) return;
    return subscribeRemoteAgentEvents((event) => {
      if (
        event.type === "enrollment" &&
        event.payload.deploymentId === draft.remote?.enrollmentId
      ) {
        onDraftChange({
          ...draft,
          remote: {
            ...draft.remote,
            enrollment: event.payload,
            workerName: event.payload.body.workerName,
            workerPubkey: event.payload.body.workerPubkey,
          },
        });
      }
      if (
        event.type === "status" &&
        event.payload.body.state === "hello" &&
        event.payload.deploymentId === draft.remote?.enrollmentId
      ) {
        onDraftChange({
          ...draft,
          remote: { ...draft.remote, ready: true },
        });
      }
    });
  }, [draft, isRemoteMode, onDraftChange]);

  const createRemoteInvitation = async () => {
    setRemoteAction("creating");
    setRemoteError(null);
    try {
      const created = await beginRemoteEnrollment();
      onDraftChange({
        ...emptyWhereToRunDraft,
        remote: {
          enrollmentId: created.invitation.enrollmentId,
          expiresAt: created.invitation.expiresAt,
          ready: false,
          setupCommand: created.setupCommand,
        },
        runOn: "remote-server",
      });
    } catch (error) {
      setRemoteError(
        error instanceof Error
          ? error.message
          : "Could not create a remote-server invitation.",
      );
    } finally {
      setRemoteAction(null);
    }
  };

  const approveRemoteWorker = async () => {
    const remote = draft.remote;
    if (!remote?.enrollment || !remote.workerPubkey) return;
    setRemoteAction("approving");
    setRemoteError(null);
    try {
      await approveRemoteEnrollment({
        enrollment: remote.enrollment,
        workerPubkey: remote.workerPubkey,
      });
    } catch (error) {
      setRemoteError(
        error instanceof Error
          ? error.message
          : "Could not approve the remote worker.",
      );
    } finally {
      setRemoteAction(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="agent-run-on">
          Run on
        </label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs"
          disabled={isPending}
          id="agent-run-on"
          onChange={(event) =>
            onDraftChange({
              ...emptyWhereToRunDraft,
              runOn: event.target.value,
            })
          }
          value={draft.runOn}
        >
          <option value="local">This computer</option>
          <option value="remote-server">A remote server</option>
          {backendProviders.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.id}
            </option>
          ))}
        </select>
      </div>

      {isRemoteMode ? (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/10">
          <div className="flex gap-3 border-b border-border/60 px-4 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold">One secure connection</p>
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                The server connects out to Buzz. No inbound port, SSH account,
                or agent private key is shared.
              </p>
            </div>
          </div>

          <div className="space-y-4 px-4 py-4">
            {!draft.remote ? (
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Create a ten-minute, one-use setup command.
                  </p>
                </div>
                <Button
                  disabled={isPending || remoteAction !== null}
                  onClick={() => void createRemoteInvitation()}
                  size="sm"
                  type="button"
                >
                  {remoteAction === "creating"
                    ? "Creating…"
                    : "Create connection"}
                </Button>
              </div>
            ) : draft.remote.ready ? (
              <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/10 px-3 py-3 text-primary">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Remote server ready</p>
                  <p className="mt-0.5 text-xs opacity-80">
                    {draft.remote.workerName ?? "Worker"} completed the
                    encrypted session handshake.
                  </p>
                </div>
              </div>
            ) : draft.remote.enrollment && draft.remote.workerPubkey ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      Verify this worker fingerprint
                    </p>
                    <code className="mt-1 block break-all text-xs text-muted-foreground">
                      {draft.remote.workerPubkey}
                    </code>
                  </div>
                </div>
                <Button
                  disabled={isPending || remoteAction !== null}
                  onClick={() => void approveRemoteWorker()}
                  size="sm"
                  type="button"
                >
                  {remoteAction === "approving"
                    ? "Approving…"
                    : "Approve this server"}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Terminal className="h-4 w-4 text-muted-foreground" />
                  Run once on the remote server
                </div>
                <div className="rounded-xl border border-border/70 bg-background/80 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <code className="min-w-0 break-all text-xs leading-5">
                      {draft.remote.setupCommand}
                    </code>
                    <CopyButton
                      label="Copy"
                      value={draft.remote.setupCommand}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Waiting for the server. This invitation expires at{" "}
                  {new Date(
                    draft.remote.expiresAt * 1_000,
                  ).toLocaleTimeString()}
                  .
                </p>
              </div>
            )}

            {remoteError ? (
              <p
                className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {remoteError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {isProviderMode && selectedBackendProvider ? (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-warning">
              This provider at{" "}
              <span className="font-mono font-medium">
                {selectedBackendProvider.binaryPath}
              </span>{" "}
              will receive your agent&apos;s private key. Only use providers
              from trusted sources.
            </p>
          </div>
          {probeError ? (
            <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              Could not probe provider: {probeError}
            </p>
          ) : null}
          {draft.probedProvider?.config_schema ? (
            <ProviderConfigFields
              config={draft.providerConfig}
              onChange={(providerConfig) =>
                onDraftChange({ ...draft, providerConfig })
              }
              schema={draft.probedProvider.config_schema}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

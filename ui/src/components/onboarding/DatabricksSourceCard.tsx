import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AiConnectionBinding, AiManagedConnectionSummary } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AiConnectionCredentialStep } from "../ai-connections/AiConnectionCredentialStep";
import { OnboardingLoginCard } from "../AdapterLoginChrome";

/**
 * The onboarding source id for Databricks Unity Gateway.
 *
 * Not an adapter type. Databricks is an AI connection provider that runs on
 * the `codex_local` harness, so picking this tile hires a Codex agent bound to
 * a Databricks connection and a Unity Catalog combo as its model.
 */
export const DATABRICKS_SOURCE_ID = "databricks";
export const DATABRICKS_SOURCE_ADAPTER_TYPE = "codex_local";

const NEW_CONNECTION_VALUE = "__new_databricks_connection__";

/** Shared with `useSavedProviderKeys`, so a save invalidates both lists at once. */
export function aiConnectionsQueryKey(companyId: string) {
  return ["ai-connections", companyId] as const;
}

/** Databricks connections the signed-in user can hire an agent against right now. */
export function usableDatabricksConnections(
  connections: readonly AiManagedConnectionSummary[] | undefined,
): AiManagedConnectionSummary[] {
  return (connections ?? []).filter(
    (connection) =>
      connection.provider === "databricks" &&
      connection.method === "oauth_m2m" &&
      connection.status === "connected",
  );
}

/**
 * The runtime binding a hire carries for a Databricks connection.
 *
 * A company-shared connection is named exactly. A personal one can only be
 * bound through the responsible user's provider default — the binding schema
 * has no explicit personal mode — so the caller makes it that default before
 * the hire (see `aiConnectionsApi.setDefault`).
 */
export function databricksBindingFor(connection: AiManagedConnectionSummary): AiConnectionBinding {
  return connection.ownership === "shared"
    ? {
        provider: "databricks",
        method: "oauth_m2m",
        mode: "shared",
        connectionId: connection.id,
        grantId: connection.grantId,
      }
    : { provider: "databricks", method: "oauth_m2m", mode: "responsible_user" };
}

/**
 * The connect step's card for the Databricks source: pick (or create) a
 * Databricks connection, then pick the Unity Catalog combo the agent runs.
 *
 * The step owns the hire; this card only answers "which connection" and
 * "which combo". It picks sensible defaults for both so a company with one
 * workspace and one combo has nothing to choose.
 */
export function DatabricksSourceCard({
  companyId,
  connection,
  onConnectionChange,
  model,
  onModelChange,
  disabled = false,
  onCancel,
}: {
  companyId: string;
  connection: AiManagedConnectionSummary | null;
  onConnectionChange: (connection: AiManagedConnectionSummary | null) => void;
  model: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  /** Leaving the form with nothing to fall back to leaves the step. */
  onCancel: () => void;
}) {
  const [adding, setAdding] = useState(false);
  /** A connection the form just created, waiting for the list to include it. */
  const [pending, setPending] = useState<{ id: string; since: number } | null>(null);
  const pendingConnectionId = pending?.id ?? null;

  const accounts = useQuery({
    queryKey: aiConnectionsQueryKey(companyId),
    queryFn: () => aiConnectionsApi.list(companyId),
    retry: false,
  });
  const usable = usableDatabricksConnections(accounts.data?.connections);
  const selectedId = connection?.id ?? null;

  // Keep the selection pointing at a connection that still exists, adopt a
  // connection the form just created once the list has it, and otherwise
  // default to the user's Databricks default or the only/first connection.
  useEffect(() => {
    if (!accounts.data) return;
    if (pending) {
      const created = usable.find((candidate) => candidate.id === pending.id);
      if (created) {
        setPending(null);
        onConnectionChange(created);
        return;
      }
      // A list fetched after the save that still lacks it will not grow it
      // later; stop waiting and fall back to the ordinary default below.
      if (accounts.dataUpdatedAt <= pending.since) return;
      setPending(null);
    }
    const current = selectedId ? usable.find((candidate) => candidate.id === selectedId) : undefined;
    if (current) {
      // Refresh the summary (ownership, default flag) without changing the choice.
      if (JSON.stringify(current) !== JSON.stringify(connection)) {
        onConnectionChange(current);
      }
      return;
    }
    const fallback = usable.find((candidate) => candidate.isDefault) ?? usable[0] ?? null;
    if ((fallback?.id ?? null) !== selectedId) onConnectionChange(fallback);
    // `usable` is derived from `accounts.data`; depending on the data is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data, accounts.dataUpdatedAt, pending, selectedId]);

  const combos = useQuery({
    queryKey: queryKeys.agents.adapterModels(
      companyId,
      DATABRICKS_SOURCE_ADAPTER_TYPE,
      null,
      DATABRICKS_SOURCE_ID,
      selectedId,
    ),
    queryFn: () =>
      agentsApi.adapterModels(companyId, DATABRICKS_SOURCE_ADAPTER_TYPE, {
        environmentId: null,
        provider: DATABRICKS_SOURCE_ID,
        connectionId: selectedId!,
      }),
    enabled: Boolean(selectedId),
    retry: false,
    // Matches the server-side discovery cache TTL, like the agent config form.
    staleTime: 60_000,
  });

  // A combo is required: Codex's own default model is not served by the
  // gateway. Default to the first combo when the current one is not offered.
  useEffect(() => {
    if (!selectedId || !combos.data) return;
    if (combos.data.some((combo) => combo.id === model)) return;
    onModelChange(combos.data[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combos.data, selectedId]);

  const showForm = adding || (accounts.isSuccess && usable.length === 0 && !pendingConnectionId);

  if (accounts.isPending || pendingConnectionId) {
    return <OnboardingLoginCard instruction="Loading Databricks connections" loading>{null}</OnboardingLoginCard>;
  }

  if (accounts.error) {
    return (
      <OnboardingLoginCard instruction="Connect Databricks Unity Gateway">
        <p role="alert" className="text-sm text-destructive">
          {accounts.error instanceof Error ? accounts.error.message : "Could not load AI connections."}
        </p>
      </OnboardingLoginCard>
    );
  }

  if (showForm) {
    return (
      <OnboardingLoginCard instruction="Connect a Databricks workspace with a service principal (OAuth M2M)">
        <AiConnectionCredentialStep
          companyId={companyId}
          provider="databricks"
          initialMethod="oauth_m2m"
          fixedMethod
          name="Databricks"
          // Company-shared by default: the first agent hires the rest of the
          // team, and a shared connection is one they all inherit regardless
          // of which member is responsible for a run.
          ownership="shared"
          agentIds={[]}
          allAgents
          onComplete={(result) => {
            setAdding(false);
            setPending({ id: result.connectionId, since: Date.now() });
          }}
          onCancel={() => {
            if (usable.length > 0) setAdding(false);
            else onCancel();
          }}
        />
      </OnboardingLoginCard>
    );
  }

  const comboError = combos.error instanceof Error ? combos.error.message : combos.error ? "Could not load combos." : null;

  return (
    <OnboardingLoginCard instruction="Choose the Databricks connection and the combo this agent runs">
      <label className="block space-y-2 text-sm">
        <span>Databricks connection</span>
        <Select
          value={selectedId ?? ""}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === NEW_CONNECTION_VALUE) {
              setAdding(true);
              return;
            }
            onConnectionChange(usable.find((candidate) => candidate.id === value) ?? null);
          }}
        >
          <SelectTrigger className="w-full" aria-label="Databricks connection">
            <SelectValue placeholder="Choose a connection" />
          </SelectTrigger>
          <SelectContent>
            {usable.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.ownership === "shared" ? " (company shared)" : " (personal)"}
              </SelectItem>
            ))}
            <SelectItem value={NEW_CONNECTION_VALUE}>Connect another workspace…</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <label className="block space-y-2 text-sm">
        <span>Combo</span>
        <Select
          value={model}
          disabled={disabled || !combos.data?.length}
          onValueChange={onModelChange}
        >
          <SelectTrigger className="w-full" aria-label="Combo">
            <SelectValue placeholder={combos.isFetching ? "Loading combos…" : "Choose a combo"} />
          </SelectTrigger>
          <SelectContent>
            {(combos.data ?? []).map((combo) => (
              <SelectItem key={combo.id} value={combo.id}>
                {combo.label || combo.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {comboError ? (
        <p role="alert" className="text-sm text-destructive">{comboError}</p>
      ) : combos.isSuccess && combos.data.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No combos found in this connection&apos;s catalog and schema. Create one in Databricks, then come back.
        </p>
      ) : null}
    </OnboardingLoginCard>
  );
}

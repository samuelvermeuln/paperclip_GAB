import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AiProvider, type AiAuthMethod, type AiConnectionLoginIntent } from "@paperclipai/shared";
import { AgentProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect, type SearchableSelectGroup } from "@/components/SearchableSelect";
import { aiConnectionsApi, type DatabricksModelServiceOption } from "@/api/ai-connections";
import { ApiError } from "@/api/client";
import { environmentsApi } from "@/api/environments";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { resolveAdapterTestEnvironmentId, resolveLocalDefaultEnvironmentId, resolveManagedSandboxEnvironmentId } from "@/lib/adapter-test-environment";
import { resolveForcedKubernetesEnvironment } from "@/lib/forced-kubernetes-environment";

type Props = {
  companyId: string;
  provider: AiProvider;
  initialMethod?: AiAuthMethod;
  fixedMethod?: boolean;
  connectionId?: string;
  name: string;
  ownership: "personal" | "shared";
  agentIds: string[];
  allAgents: boolean;
  environmentId?: string;
  onComplete: (result: { connectionId: string; grantId: string; method: AiAuthMethod }) => void;
  onCancel: () => void;
};

/** Connections hosts the same provider step as agent setup, with its own save intent. */
export function AiConnectionCredentialStep(props: Props) {
  if (props.provider === "openrouter") return <ApiKeyConnectionStep {...props} />;
  if (props.provider === "databricks") return <DatabricksConnectionStep {...props} />;
  return <SubscriptionConnectionStep {...props} />;
}

function SubscriptionConnectionStep({ companyId, provider, initialMethod, fixedMethod, connectionId, name: initialName, ownership, agentIds, allAgents, environmentId: suppliedEnvironmentId, onComplete, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [chosenEnvironment, setChosenEnvironment] = useState<string>();
  const client = useQueryClient();
  const envs = useQuery({ queryKey: queryKeys.environments.list(companyId), queryFn: () => environmentsApi.list(companyId) });
  const caps = useQuery({ queryKey: queryKeys.environments.capabilities(companyId), queryFn: () => environmentsApi.capabilities(companyId) });
  const settings = useQuery({ queryKey: queryKeys.instance.settings, queryFn: instanceSettingsApi.get });
  const experimental = useQuery({ queryKey: queryKeys.instance.experimentalSettings, queryFn: instanceSettingsApi.getExperimental });
  const general = useQuery({ queryKey: queryKeys.instance.generalSettings, queryFn: instanceSettingsApi.getGeneral });
  const forced = resolveForcedKubernetesEnvironment(general.data?.executionMode, envs.data ?? []);
  let environmentId: string | null = null;
  let environmentError: string | undefined;
  try {
    environmentId = forced.forced ? forced.kubernetesEnvironment?.id ?? null : resolveAdapterTestEnvironmentId({
      agentDefaultEnvironmentId: suppliedEnvironmentId ?? chosenEnvironment,
      instanceDefaultEnvironmentId: settings.data?.defaultEnvironmentId,
      localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(envs.data),
      managedSandboxOnly: experimental.data?.enableManagedSandboxOnly,
      managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(envs.data),
      visibleEnvironmentIds: envs.data?.map((env) => env.id),
    });
  } catch (error) { environmentError = error instanceof Error ? error.message : "Could not resolve the sign-in environment."; }
  const loginEnvironments = (envs.data ?? []).filter((env) =>
    env.status === "active" && (env.driver === "local" || (env.driver === "sandbox" &&
    typeof env.config.provider === "string" &&
    caps.data?.sandboxProviders?.[env.config.provider]?.supportsLoginPty === true)),
  );
  // Signing in may use a different environment from later agent execution.
  // Prefer a supported login environment without changing any agent routing.
  if (!forced.forced && !suppliedEnvironmentId && !chosenEnvironment &&
      !loginEnvironments.some((env) => env.id === environmentId)) {
    environmentId = loginEnvironments[0]?.id ?? null;
  }
  const environment = envs.data?.find((env) => env.id === environmentId);
  const sandboxProvider = typeof environment?.config.provider === "string" ? environment.config.provider : "";
  const canLogin = environment?.driver === "sandbox" && caps.data?.sandboxProviders?.[sandboxProvider]?.supportsLoginPty === true;
  const loading = [envs, caps, settings, experimental, general].some((query) => query.isPending);
  const error = environmentError ?? [envs, caps, settings, experimental, general].find((query) => query.error)?.error?.message;
  const intent: AiConnectionLoginIntent = { provider, method: "subscription", name, ownership, agentIds, allAgents, connectionId };
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-6">
    <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>
    {!suppliedEnvironmentId && !forced.forced && loginEnvironments.length > 1 && <Select value={environmentId ?? ""} onValueChange={setChosenEnvironment}>
      <SelectTrigger aria-label="Sign-in environment"><SelectValue placeholder="Sign-in environment" /></SelectTrigger>
      <SelectContent>{loginEnvironments.map((env) => <SelectItem key={env.id} value={env.id}>{env.name}</SelectItem>)}</SelectContent>
    </Select>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="text-sm text-muted-foreground">Preparing sign-in…</p> : <AgentProviderConnection
      key={environmentId ?? "local"}
      companyId={companyId}
      adapterType={provider === "anthropic" ? "claude_local" : provider === "xai" ? "grok_local" : "codex_local"}
      environmentId={environmentId}
      canLogin={canLogin}
      localEnvironment={environment?.driver === "local"}
      onBack={onCancel}
      onConnected={() => {}}
      testConnection={async () => false}
      managedAccount={{ intent, initialMethod: initialMethod === "oauth_m2m" ? undefined : initialMethod, fixedMethod: fixedMethod || Boolean(connectionId), disabled: loading || Boolean(error) || !name.trim(), onComplete: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); onComplete(result); } }}
    />}
  </div>;
}

function ApiKeyConnectionStep({ companyId, provider, connectionId, name: initialName, ownership, agentIds, allAgents, onComplete, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [apiKey, setApiKey] = useState("");
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => aiConnectionsApi.create(companyId, { provider, method: "api_key", name, ownership, agentIds, allAgents, connectionId, apiKey }),
    onSuccess: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); onComplete({ ...result, method: "api_key" }); },
    onSettled: () => setApiKey(""),
  });
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
    <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    <ProviderApiKeyCard providerName="OpenRouter" value={apiKey} onChange={setApiKey} onSubmit={() => save.mutate()} disabled={save.isPending} placeholder="Enter API key here" autoFocus />
    <div className="flex justify-between gap-2"><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button disabled={!name.trim() || !apiKey.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Connecting…" : "Connect"}</Button></div>
  </div>;
}

function DatabricksConnectionStep({ companyId, connectionId, name: initialName, ownership: initialOwnership, agentIds, allAgents, onComplete, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [workspaceHost, setWorkspaceHost] = useState("");
  const [clientId, setClientId] = useState("");
  // Never seeded from a prior value and cleared on settle: the secret is write-only in the UI.
  const [clientSecret, setClientSecret] = useState("");
  const [ownership, setOwnership] = useState<"personal" | "shared">(initialOwnership);
  // The discovery draft: absent while the credential form (Etapa A) is shown,
  // set once authentication succeeds (Etapa B). Changing host/credentials
  // always goes through `resetToConnect`, which drops this — invalidating
  // every downstream catalog/schema/combo selection with it.
  const [session, setSession] = useState<{ id: string; expiresAt: string } | null>(null);
  const [catalog, setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [modelPrefix, setModelPrefix] = useState("");
  const client = useQueryClient();

  const connect = useMutation({
    mutationFn: () =>
      aiConnectionsApi.startDatabricksDiscovery(companyId, {
        workspaceHost: workspaceHost.trim(),
        clientId: clientId.trim(),
        clientSecret,
      }),
    onSuccess: (result) => setSession({ id: result.discoverySessionId, expiresAt: result.expiresAt }),
    // Clear the secret whether the connect succeeded or failed — it never survives a submit in the UI.
    onSettled: () => setClientSecret(""),
  });

  function resetToConnect() {
    setSession(null);
    setCatalog("");
    setSchema("");
  }
  function cancelDraft() {
    if (session) void aiConnectionsApi.cancelDatabricksDiscovery(companyId, session.id).catch(() => {});
    resetToConnect();
  }

  const catalogsKey = ["ai-connections", "databricks-discovery", session?.id, "catalogs"] as const;
  const catalogsQuery = useQuery({
    queryKey: catalogsKey,
    queryFn: () => aiConnectionsApi.databricksCatalogs(companyId, session!.id),
    enabled: Boolean(session),
    retry: false,
  });
  const schemasKey = ["ai-connections", "databricks-discovery", session?.id, "schemas", catalog] as const;
  const schemasQuery = useQuery({
    queryKey: schemasKey,
    queryFn: () => aiConnectionsApi.databricksSchemas(companyId, session!.id, catalog),
    enabled: Boolean(session) && catalog.length > 0,
    retry: false,
  });
  const servicesKey = ["ai-connections", "databricks-discovery", session?.id, "model-services", catalog, schema] as const;
  const servicesQuery = useQuery({
    queryKey: servicesKey,
    queryFn: () => aiConnectionsApi.databricksModelServices(companyId, session!.id, catalog, schema),
    enabled: Boolean(session) && catalog.length > 0 && schema.length > 0,
    retry: false,
  });
  const refreshCatalogs = useMutation({
    mutationFn: () => aiConnectionsApi.databricksCatalogs(companyId, session!.id, { refresh: true }),
    onSuccess: (data) => client.setQueryData(catalogsKey, data),
  });
  const refreshSchemas = useMutation({
    mutationFn: () => aiConnectionsApi.databricksSchemas(companyId, session!.id, catalog, { refresh: true }),
    onSuccess: (data) => client.setQueryData(schemasKey, data),
  });

  const save = useMutation({
    mutationFn: () =>
      aiConnectionsApi.create(companyId, {
        provider: "databricks",
        method: "oauth_m2m",
        name,
        ownership,
        agentIds,
        allAgents,
        connectionId,
        discoverySessionId: session!.id,
        catalog,
        schema,
        modelPrefix: modelPrefix.trim() ? modelPrefix.trim() : undefined,
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["ai-connections", companyId] });
      onComplete({ ...result, method: "oauth_m2m" });
    },
  });

  // A session that expired mid-flow surfaces the same way from every endpoint
  // (410, `DATABRICKS_DISCOVERY_EXPIRED`) — never presented as "credentials
  // invalid", always as a distinct "reconnect" state (Requirement: sessão
  // expirada is one of the required states).
  const expired = [catalogsQuery.error, schemasQuery.error, servicesQuery.error, save.error].some(isDiscoveryExpiredError);

  if (!session) {
    const complete = [name, workspaceHost, clientId, clientSecret].every((value) => value.trim().length > 0);
    return (
      <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
        <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>
        <label className="block space-y-2 text-sm">Workspace URL<Input value={workspaceHost} onChange={(event) => setWorkspaceHost(event.target.value)} placeholder="https://your-workspace.cloud.databricks.com" autoComplete="off" spellCheck={false} /></label>
        <label className="block space-y-2 text-sm">Client ID<Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <label className="block space-y-2 text-sm">Client secret<Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        {connect.isPending && <p role="status" className="text-sm text-muted-foreground">Verifying connection…</p>}
        {connect.error && <p role="alert" className="text-sm text-destructive">{discoveryErrorMessage(connect.error)}</p>}
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button disabled={!complete || connect.isPending} onClick={() => connect.mutate()}>
            {connect.isPending ? "Verifying connection…" : "Connect and find options"}
          </Button>
        </div>
      </div>
    );
  }

  const services = servicesQuery.data?.items ?? [];
  const canSave = catalog.length > 0 && schema.length > 0 && !save.isPending;
  const catalogGroups: SearchableSelectGroup[] = [{
    id: "catalogs",
    options: (catalogsQuery.data?.items ?? []).map((item) => ({ key: item.name, value: item.name, label: item.name, searchText: item.comment })),
  }];
  const schemaGroups: SearchableSelectGroup[] = [{
    id: "schemas",
    options: (schemasQuery.data?.items ?? []).map((item) => ({ key: item.name, value: item.name, label: item.name })),
  }];
  return (
    <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
      <p className="text-sm text-green-700 dark:text-green-300">Authenticated to {workspaceHost || "the workspace"}.</p>
      {expired ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="text-destructive">This discovery session has expired. Reconnect to continue.</p>
          <Button size="sm" onClick={resetToConnect}>Reconnect</Button>
        </div>
      ) : (
        <>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span>Catalog</span>
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => refreshCatalogs.mutate()} disabled={refreshCatalogs.isPending}>
                {refreshCatalogs.isPending ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <SearchableSelect
              value={catalog}
              groups={catalogGroups}
              onValueChange={(value) => { setCatalog(value); setSchema(""); }}
              placeholder="Select a catalog"
              searchPlaceholder="Search catalogs..."
              loading={catalogsQuery.isPending}
              emptyMessage={
                catalogsQuery.error
                  ? discoveryErrorMessage(catalogsQuery.error)
                  : "Connection authenticated. No accessible catalog was returned for this service principal."
              }
            />
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span>Schema</span>
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" disabled={!catalog || refreshSchemas.isPending} onClick={() => refreshSchemas.mutate()}>
                {refreshSchemas.isPending ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <SearchableSelect
              value={schema}
              groups={schemaGroups}
              onValueChange={setSchema}
              placeholder={catalog ? "Select a schema" : "Choose a catalog first"}
              searchPlaceholder="Search schemas..."
              disabled={!catalog}
              loading={schemasQuery.isPending}
              emptyMessage={
                schemasQuery.error
                  ? discoveryErrorMessage(schemasQuery.error)
                  : "No accessible schema was returned in this catalog."
              }
            />
          </div>
          {catalog && schema && (
            <div className="rounded-md border border-border p-3 text-sm">
              {servicesQuery.isPending && <p className="text-muted-foreground">Looking for combos…</p>}
              {servicesQuery.error && <p className="text-destructive">{discoveryErrorMessage(servicesQuery.error)}</p>}
              {!servicesQuery.isPending && !servicesQuery.error && services.length === 0 && (
                <p className="text-muted-foreground">No service is visible in this schema. Choose another schema or check access in Databricks.</p>
              )}
              {!servicesQuery.isPending && !servicesQuery.error && services.length > 0 && (
                <>
                  <p className="font-medium">{services.length} combo{services.length === 1 ? "" : "s"} found</p>
                  <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                    {services.map((item: DatabricksModelServiceOption) => <li key={item.id} className="truncate">{item.label}</li>)}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">Execution not yet verified — Databricks authorizes each run separately.</p>
                </>
              )}
            </div>
          )}
          <label className="block space-y-2 text-sm">Prefix (optional)<Input value={modelPrefix} onChange={(event) => setModelPrefix(event.target.value)} autoComplete="off" spellCheck={false} /></label>
          <label className="block space-y-2 text-sm">Sharing<Select value={ownership} onValueChange={(value) => setOwnership(value as "personal" | "shared")} disabled={Boolean(connectionId)}>
            <SelectTrigger className="w-full" aria-label="Sharing"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="personal">Personal</SelectItem>
              <SelectItem value="shared">Company shared</SelectItem>
            </SelectContent>
          </Select></label>
          {save.error && <p role="alert" className="text-sm text-destructive">{discoveryErrorMessage(save.error)}</p>}
        </>
      )}
      <div className="flex justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { cancelDraft(); onCancel(); }}>Cancel</Button>
          <Button variant="ghost" onClick={resetToConnect}>Back</Button>
        </div>
        <Button disabled={!canSave} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}

/** True for a `DatabricksDiscoveryFailure` carrying `DATABRICKS_DISCOVERY_EXPIRED`
 * (HTTP 410) — the draft's TTL lapsed mid-flow. Never conflated with an
 * authentication or access-denied failure. */
function isDiscoveryExpiredError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const body = error.body as { code?: string; details?: { code?: string } } | null;
  return body?.code === "DATABRICKS_DISCOVERY_EXPIRED" || body?.details?.code === "DATABRICKS_DISCOVERY_EXPIRED";
}

function discoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

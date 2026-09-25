import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AiProvider, type AiAuthMethod, type AiConnectionLoginIntent } from "@paperclipai/shared";
import { AgentProviderConnection } from "@/components/new-agent/AgentProviderConnection";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { aiConnectionsApi } from "@/api/ai-connections";
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
  const [catalog, setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [modelPrefix, setModelPrefix] = useState("");
  const [ownership, setOwnership] = useState<"personal" | "shared">(initialOwnership);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => aiConnectionsApi.create(companyId, {
      provider: "databricks",
      method: "oauth_m2m",
      name,
      ownership,
      agentIds,
      allAgents,
      connectionId,
      clientId: clientId.trim(),
      clientSecret,
      workspaceHost: workspaceHost.trim(),
      catalog: catalog.trim(),
      schema: schema.trim(),
      modelPrefix: modelPrefix.trim() ? modelPrefix.trim() : undefined,
    }),
    onSuccess: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); onComplete({ ...result, method: "oauth_m2m" }); },
    // Clear the secret whether the save succeeded or failed — it never survives a submit in the UI.
    onSettled: () => setClientSecret(""),
  });
  const complete = [name, workspaceHost, clientId, clientSecret, catalog, schema].every((value) => value.trim().length > 0);
  return <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
    <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(connectionId)} /></label>
    <label className="block space-y-2 text-sm">Workspace URL<Input value={workspaceHost} onChange={(event) => setWorkspaceHost(event.target.value)} placeholder="https://your-workspace.cloud.databricks.com" autoComplete="off" spellCheck={false} /></label>
    <label className="block space-y-2 text-sm">Client ID<Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label className="block space-y-2 text-sm">Client secret<Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label className="block space-y-2 text-sm">Catalog<Input value={catalog} onChange={(event) => setCatalog(event.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label className="block space-y-2 text-sm">Schema<Input value={schema} onChange={(event) => setSchema(event.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label className="block space-y-2 text-sm">Prefix (optional)<Input value={modelPrefix} onChange={(event) => setModelPrefix(event.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label className="block space-y-2 text-sm">Sharing<Select value={ownership} onValueChange={(value) => setOwnership(value as "personal" | "shared")} disabled={Boolean(connectionId)}>
      <SelectTrigger className="w-full" aria-label="Sharing"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="personal">Personal</SelectItem>
        <SelectItem value="shared">Company shared</SelectItem>
      </SelectContent>
    </Select></label>
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    <div className="flex justify-between gap-2"><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button disabled={!complete || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Connecting…" : "Connect"}</Button></div>
  </div>;
}

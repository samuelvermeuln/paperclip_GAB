import type {
  AiManagedConnectionSummary,
  CreateAiConnection,
  AiConnectionLoginIntent,
  LocalAiLoginAttempt,
  LocalAiLoginStatus,
  DatabricksDiscoverySessionCreateInput,
  DatabricksDiscoverySessionStarted,
  DatabricksCatalogOption,
  DatabricksSchemaOption,
} from "@paperclipai/shared";
import { api } from "./client";

/** A discovered Databricks combo (Unity Catalog Model Service), as surfaced by
 * the discovery-session model-services endpoint. Mirrors `AdapterModel`
 * (`{ id, label }`) without importing the adapter-utils package into the UI. */
export interface DatabricksModelServiceOption {
  id: string;
  label: string;
}

export const aiConnectionsApi = {
  startLocalLogin: (companyId: string, input: AiConnectionLoginIntent & { restart?: boolean }) => api.post<LocalAiLoginAttempt>(`/companies/${companyId}/ai-connections/local/attempts`, input),
  checkLocalLogin: (companyId: string, input: AiConnectionLoginIntent & { localSessionId?: string }) => api.post<LocalAiLoginStatus>(`/companies/${companyId}/ai-connections/local/check`, input),
  cancelLocalLogin: (companyId: string, sessionId: string) => api.delete(`/companies/${companyId}/ai-connections/local/attempts/${sessionId}`),
  connectLocal: (companyId: string, input: AiConnectionLoginIntent & { localSessionId?: string }) => api.post<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections/local`, input),
  activeRuns: (companyId: string, connectionId: string) => api.get<Array<{ id: string; agentId: string; agentName: string; status: string }>>(`/companies/${companyId}/ai-connections/${connectionId}/active-runs`),
  list: (companyId: string, agentId?: string) => api.get<{ currentUserId: string; connections: AiManagedConnectionSummary[] }>(`/companies/${companyId}/ai-connections${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`),
  create: (companyId: string, input: CreateAiConnection) => api.post<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections`, input),
  setDefault: (companyId: string, grantId: string) => api.put(`/companies/${companyId}/ai-connections/default`, { grantId }),
  loginResult: (companyId: string, sessionId: string) => api.get<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections/login/${encodeURIComponent(sessionId)}`),
  // Databricks catalog/schema/combo discovery drafts: authenticate once (Workspace
  // URL + Client ID/Client secret), then page through the resulting catalogs,
  // schemas, and combos without ever resending the credential.
  startDatabricksDiscovery: (companyId: string, input: DatabricksDiscoverySessionCreateInput) =>
    api.post<DatabricksDiscoverySessionStarted>(`/companies/${companyId}/ai-connections/databricks/discovery-sessions`, input),
  cancelDatabricksDiscovery: (companyId: string, sessionId: string) =>
    api.delete(`/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}`),
  databricksCatalogs: (companyId: string, sessionId: string, options?: { refresh?: boolean }) =>
    api.get<{ items: DatabricksCatalogOption[] }>(
      `/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/catalogs${options?.refresh ? "?refresh=1" : ""}`,
    ),
  databricksSchemas: (companyId: string, sessionId: string, catalog: string, options?: { refresh?: boolean }) =>
    api.get<{ items: DatabricksSchemaOption[] }>(
      `/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/schemas?${new URLSearchParams({
        catalog,
        ...(options?.refresh ? { refresh: "1" } : {}),
      }).toString()}`,
    ),
  databricksModelServices: (
    companyId: string,
    sessionId: string,
    catalog: string,
    schema: string,
    options?: { modelPrefix?: string; refresh?: boolean },
  ) =>
    api.get<{ items: DatabricksModelServiceOption[] }>(
      `/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/model-services?${new URLSearchParams({
        catalog,
        schema,
        ...(options?.modelPrefix ? { modelPrefix: options.modelPrefix } : {}),
        ...(options?.refresh ? { refresh: "1" } : {}),
      }).toString()}`,
    ),
};

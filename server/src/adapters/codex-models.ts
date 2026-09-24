import type { AdapterModel } from "./types.js";
import type { AdapterModelDiscoveryContext } from "@paperclipai/adapter-utils";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { readConfigFile } from "../config-file.js";
import { unprocessable } from "../errors.js";
import { listDatabricksModelServices } from "../services/databricks-model-services.js";

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...codexFallbackModels,
  ]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

async function fetchOpenAiModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({ id, label: id });
    }
    return dedupeModels(models);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCodexModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const apiKey = resolveOpenAiApiKey();
  const fallback = dedupeModels(codexFallbackModels);
  if (!apiKey) return fallback;

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchOpenAiModels(apiKey);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

/**
 * Resolves the Databricks Unity Gateway combo list for a `provider:
 * "databricks"` discovery context. Never merged with OpenAI/fallback models
 * (Requirement 4.4) — this is the sole return value for the Databricks
 * branch.
 */
async function loadDatabricksCodexModels(
  context: AdapterModelDiscoveryContext,
  options?: { refresh?: boolean },
): Promise<AdapterModel[]> {
  if (!context.resolvedCredential || !context.connectionId) {
    throw unprocessable("Databricks connection is required to list combos");
  }
  const { resolvedCredential } = context;
  return listDatabricksModelServices(
    {
      companyId: context.companyId,
      connectionId: context.connectionId,
      host: resolvedCredential.host,
      catalog: resolvedCredential.catalog,
      schema: resolvedCredential.schema,
      modelPrefix: resolvedCredential.modelPrefix,
    },
    resolvedCredential,
    { refresh: options?.refresh ?? context.refresh },
  );
}

export async function listCodexModels(
  context?: AdapterModelDiscoveryContext,
): Promise<AdapterModel[]> {
  if (context?.provider === "databricks") {
    return loadDatabricksCodexModels(context);
  }
  return loadCodexModels();
}

export async function refreshCodexModels(
  context?: AdapterModelDiscoveryContext,
): Promise<AdapterModel[]> {
  if (context?.provider === "databricks") {
    return loadDatabricksCodexModels(context, { refresh: true });
  }
  return loadCodexModels({ forceRefresh: true });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
}

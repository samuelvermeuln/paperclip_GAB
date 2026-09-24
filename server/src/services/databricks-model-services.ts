import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * Sole owner of Unity Catalog Model Services REST access: pagination,
 * normalization, caching, and Databricks-specific error mapping. No other
 * module should call the Databricks Unity Catalog API directly.
 *
 * This module never calls `GET /api/2.0/serving-endpoints` — that is a
 * different resource and is explicitly out of scope for discovery.
 */

/** A resolved, server-side-only Databricks credential for one connection. */
export interface DatabricksModelServiceCredential {
  /** Origin only, e.g. "https://acme.cloud.databricks.com". Never logged. */
  host: string;
  /** Personal access token. Resolved server-side only, never logged. */
  token: string;
  catalog: string;
  schema: string;
  modelPrefix?: string;
}

/** The full cache/discovery identity for a single connection's combo list. */
export interface DatabricksDiscoveryKey {
  companyId: string;
  connectionId: string;
  host: string;
  catalog: string;
  schema: string;
  modelPrefix?: string;
}

export type DatabricksDiscoveryErrorKind =
  | "invalid_credential" // 401
  | "insufficient_permission" // 403
  | "rate_limited" // 429, carries retryAfterSeconds
  | "unavailable" // 5xx / network / timeout
  | "invalid_host"; // fails https/origin validation

/**
 * Thrown by every failure path in this module. The message is always a
 * fixed, generic string per `kind` — it never interpolates response bodies,
 * headers, or the credential, so the token can never leak into a thrown
 * error message.
 */
export class DatabricksDiscoveryError extends Error {
  constructor(
    readonly kind: DatabricksDiscoveryErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "DatabricksDiscoveryError";
  }
}

const MODEL_SERVICES_PREFIX = "model-services/";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
/** Defensive cap on a single page response body; Unity Catalog pages are small JSON. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

interface RawModelService {
  name?: unknown;
}

interface ModelServicesPage {
  model_services?: RawModelService[];
  next_page_token?: string;
}

interface CacheEntry {
  cachedAt: number;
  value: AdapterModel[];
}

const cache = new Map<string, CacheEntry>();
/** Coalesces concurrent identical requests so a cache stampede issues one call. */
const pending = new Map<string, Promise<AdapterModel[]>>();
/** connectionId -> set of full cache keys, so invalidation can be scoped without a full scan. */
const keysByConnectionId = new Map<string, Set<string>>();

function serializeKey(key: DatabricksDiscoveryKey): string {
  return JSON.stringify([
    key.companyId,
    key.connectionId,
    key.host,
    key.catalog,
    key.schema,
    key.modelPrefix ?? null,
  ]);
}

function trackKey(key: DatabricksDiscoveryKey, cacheKey: string): void {
  const set = keysByConnectionId.get(key.connectionId) ?? new Set<string>();
  set.add(cacheKey);
  keysByConnectionId.set(key.connectionId, set);
}

/** Invalidates every cache entry for a connection. Called on connection edit/revoke. */
export function invalidateDatabricksModelServiceCache(connectionId: string): void {
  const keys = keysByConnectionId.get(connectionId);
  if (!keys) return;
  for (const cacheKey of keys) {
    cache.delete(cacheKey);
    pending.delete(cacheKey);
  }
  keysByConnectionId.delete(connectionId);
}

/**
 * Lists all combos visible to the credential's token under `catalog.schema`.
 * Cached (60s TTL), keyed by the full `DatabricksDiscoveryKey`. `refresh:
 * true` bypasses and repopulates the cache.
 */
export async function listDatabricksModelServices(
  key: DatabricksDiscoveryKey,
  credential: DatabricksModelServiceCredential,
  options?: { refresh?: boolean },
): Promise<AdapterModel[]> {
  assertValidHost(credential.host);

  const cacheKey = serializeKey(key);
  if (!options?.refresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
    const inFlight = pending.get(cacheKey);
    if (inFlight) return inFlight;
  }

  const request = fetchAndNormalize(credential).then((value) => {
    cache.set(cacheKey, { cachedAt: Date.now(), value });
    trackKey(key, cacheKey);
    return value;
  });
  pending.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pending.delete(cacheKey);
  }
}

async function fetchAndNormalize(
  credential: DatabricksModelServiceCredential,
): Promise<AdapterModel[]> {
  const services = await fetchAllPages(credential);
  const normalized = services
    .map(toAdapterModel)
    .filter((model): model is AdapterModel => model !== null)
    .filter((model) => qualifiesUnderCatalogSchema(model.id, credential.catalog, credential.schema))
    .filter((model) => matchesPrefix(model.id, credential.modelPrefix));
  return sortByLabel(dedupeById(normalized));
}

async function fetchAllPages(
  credential: DatabricksModelServiceCredential,
): Promise<RawModelService[]> {
  const services: RawModelService[] = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchPage(credential, pageToken);
    if (Array.isArray(page.model_services)) services.push(...page.model_services);
    pageToken = page.next_page_token && page.next_page_token.length > 0 ? page.next_page_token : undefined;
  } while (pageToken);
  return services;
}

/**
 * Validates a Databricks PAT and workspace config (host/catalog/schema) live,
 * with a single bounded request and no pagination or caching. Used at
 * connection-create time, before a `connectionId` exists to key a cache
 * entry by. Throws `DatabricksDiscoveryError` on any failure
 * (`invalid_credential`, `insufficient_permission`, `rate_limited`,
 * `unavailable`, `invalid_host`); never leaks the token or response body.
 */
export async function validateDatabricksCredential(
  credential: DatabricksModelServiceCredential,
): Promise<void> {
  assertValidHost(credential.host);
  await fetchPage(credential, undefined);
}

async function fetchPage(
  credential: DatabricksModelServiceCredential,
  pageToken: string | undefined,
): Promise<ModelServicesPage> {
  const url = new URL("/api/2.1/unity-catalog/model-services", credential.host);
  url.searchParams.set("parent", `schemas/${credential.catalog}.${credential.schema}`);
  url.searchParams.set("page_size", String(PAGE_SIZE));
  url.searchParams.set("view", "BASIC");
  if (pageToken) url.searchParams.set("page_token", pageToken);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw mapNetworkError(error);
  }

  if (!response.ok) throw await mapHttpErrorStatus(response);

  return readBoundedJson(response);
}

/** Reads the body up to a bounded size, then parses it as JSON. */
async function readBoundedJson(response: Response): Promise<ModelServicesPage> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new DatabricksDiscoveryError(
          "unavailable",
          "Databricks workspace returned a response that exceeded the processing limit",
        );
      }
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(parts).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as ModelServicesPage;
  } catch {
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks workspace returned a malformed model-services response",
    );
  }
}

function mapNetworkError(error: unknown): DatabricksDiscoveryError {
  if (error instanceof DatabricksDiscoveryError) return error;
  const isAbort = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new DatabricksDiscoveryError(
    "unavailable",
    isAbort
      ? "Databricks workspace did not respond in time"
      : "Databricks workspace could not be reached",
  );
}

async function mapHttpErrorStatus(response: Response): Promise<DatabricksDiscoveryError> {
  // Drain and discard the body without ever including it in a message; provider
  // error bodies may echo request context and must never be logged or surfaced.
  await response.body?.cancel().catch(() => {});

  if (response.status === 401) {
    return new DatabricksDiscoveryError(
      "invalid_credential",
      "Databricks rejected the connection's credential",
    );
  }
  if (response.status === 403) {
    return new DatabricksDiscoveryError(
      "insufficient_permission",
      "Databricks credential lacks permission for this catalog/schema",
    );
  }
  if (response.status === 429) {
    return new DatabricksDiscoveryError(
      "rate_limited",
      "Databricks is rate limiting this connection",
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  if (response.status >= 500) {
    return new DatabricksDiscoveryError(
      "unavailable",
      "Databricks workspace is temporarily unavailable",
    );
  }
  return new DatabricksDiscoveryError(
    "unavailable",
    "Databricks workspace returned an unexpected error",
  );
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  return undefined;
}

function assertValidHost(host: string): void {
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    throw new DatabricksDiscoveryError("invalid_host", "Databricks workspace host is not a valid URL");
  }
  const isOriginOnly =
    parsed.protocol === "https:" &&
    parsed.pathname === "/" &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.username &&
    !parsed.password;
  if (!isOriginOnly) {
    throw new DatabricksDiscoveryError(
      "invalid_host",
      "Databricks workspace host must be an https:// origin with no path, query, or credentials",
    );
  }
}

/**
 * Strips the `model-services/` resource-name prefix, derives a display label
 * from the last dot-separated segment, strips a leading `combo`/`combo_`/
 * `combo-` token (case-insensitive) and prepends "Combo " in its place,
 * replaces remaining separators with spaces, and title-cases the result
 * (e.g. `combo_ux` -> `Combo Ux`, `combo-dev` -> `Combo Dev`).
 */
export function toAdapterModel(service: RawModelService): AdapterModel | null {
  if (typeof service.name !== "string" || !service.name.startsWith(MODEL_SERVICES_PREFIX)) return null;
  const id = service.name.slice(MODEL_SERVICES_PREFIX.length);
  if (!id) return null;
  const shortName = id.split(".").pop() || id;
  const hadComboPrefix = /^combo[-_]?/i.test(shortName);
  const rest = shortName.replace(/^combo[-_]?/i, "");
  const withPrefix = hadComboPrefix ? `Combo ${rest}` : shortName;
  const spaced = withPrefix.replace(/[-_]+/g, " ").trim();
  const label = titleCase(spaced.length > 0 ? spaced : shortName);
  return { id, label };
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** Defensive filter: drops any entry outside the credential's configured catalog.schema. */
function qualifiesUnderCatalogSchema(id: string, catalog: string, schema: string): boolean {
  return id.startsWith(`${catalog}.${schema}.`);
}

function matchesPrefix(id: string, modelPrefix: string | undefined): boolean {
  if (!modelPrefix) return true;
  const shortName = id.split(".").pop() || id;
  return shortName.startsWith(modelPrefix);
}

function dedupeById(models: AdapterModel[]): AdapterModel[] {
  const seen = new Map<string, AdapterModel>();
  for (const model of models) {
    if (!seen.has(model.id)) seen.set(model.id, model);
  }
  return [...seen.values()];
}

function sortByLabel(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) => a.label.localeCompare(b.label));
}

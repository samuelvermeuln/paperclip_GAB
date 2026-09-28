import type {
  DatabricksCatalogOption,
  DatabricksSchemaOption,
} from "@paperclipai/shared";
import { resolveDatabricksAccessToken } from "./databricks-oauth.js";
import {
  DatabricksDiscoveryError,
  type DatabricksModelServiceCredential,
} from "./databricks-model-services.js";

/**
 * Sole owner of Unity Catalog `catalogs`/`schemas` REST access: pagination,
 * normalization, caching, and Databricks-specific error mapping for the
 * pre-combo discovery step (choosing a catalog, then a schema, before any
 * combo can be listed).
 *
 * Mirrors `databricks-model-services.ts`'s pagination/error/cache shape
 * exactly (same endpoints family, same OAuth M2M access token, same
 * classification), kept in a separate module because catalogs and schemas
 * are discovered before a `catalog`/`schema` pair exists to scope a combo
 * list by.
 */

/** The cache/discovery identity for one workspace connection's catalog list. */
export interface DatabricksHostDiscoveryKey {
  companyId: string;
  connectionId: string;
  credentialVersion: string;
  host: string;
}

/** A resolved, server-side-only Databricks credential, without a catalog/schema yet. */
export type DatabricksHostCredential = Pick<
  DatabricksModelServiceCredential,
  "host" | "clientId" | "clientSecret"
>;

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_RESULTS_PER_PAGE = 0; // Unbounded per D2/D3; the workspace paginates on its own terms.
/** Same defensive pagination cap as `databricks-model-services.ts`. */
const MAX_CONSECUTIVE_PAGES = 1000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

interface RawCatalog {
  name?: unknown;
  comment?: unknown;
}
interface CatalogsPage {
  catalogs?: RawCatalog[];
  next_page_token?: string;
}
interface RawSchema {
  name?: unknown;
  catalog_name?: unknown;
  full_name?: unknown;
}
interface SchemasPage {
  schemas?: RawSchema[];
  next_page_token?: string;
}

interface CacheEntry<T> {
  cachedAt: number;
  value: T[];
}

function serializeHostKey(key: DatabricksHostDiscoveryKey): string {
  return JSON.stringify([key.companyId, key.connectionId, key.credentialVersion, key.host]);
}

const catalogCache = new Map<string, CacheEntry<DatabricksCatalogOption>>();
const catalogPending = new Map<string, Promise<DatabricksCatalogOption[]>>();
const schemaCache = new Map<string, CacheEntry<DatabricksSchemaOption>>();
const schemaPending = new Map<string, Promise<DatabricksSchemaOption[]>>();
/** connectionId -> every cache key (catalogs and schemas) it owns, for scoped invalidation. */
const keysByConnectionId = new Map<string, Set<string>>();

function trackKey(connectionId: string, cacheKey: string): void {
  const set = keysByConnectionId.get(connectionId) ?? new Set<string>();
  set.add(cacheKey);
  keysByConnectionId.set(connectionId, set);
}

/** Invalidates every cached catalog/schema list for a connection or discovery draft. */
export function invalidateDatabricksCatalogDiscoveryCache(connectionId: string): void {
  const keys = keysByConnectionId.get(connectionId);
  if (!keys) return;
  for (const cacheKey of keys) {
    catalogCache.delete(cacheKey);
    catalogPending.delete(cacheKey);
    schemaCache.delete(cacheKey);
    schemaPending.delete(cacheKey);
  }
  keysByConnectionId.delete(connectionId);
}

/** As `DatabricksModelServiceCredential`'s host-authorization to `resolveDatabricksAccessToken`'s
 * `DatabricksDiscoveryKey`, which only reads `companyId`/`connectionId`/`credentialVersion`/`host`
 * from its key (never `catalog`/`schema`/`modelPrefix`) — so a fixed empty placeholder for the
 * latter two is inert here and never becomes part of the OAuth token's cache identity. */
function tokenKey(key: DatabricksHostDiscoveryKey) {
  return { ...key, catalog: "", schema: "" };
}

/**
 * Lists every catalog visible to the credential's service principal
 * (Requirement: paginate to completion, including through an empty
 * intermediate page). Cached 60s, keyed by the full host identity.
 */
export async function listDatabricksCatalogs(
  key: DatabricksHostDiscoveryKey,
  credential: DatabricksHostCredential,
  options?: { refresh?: boolean },
): Promise<DatabricksCatalogOption[]> {
  assertValidHost(credential.host);
  const cacheKey = serializeHostKey(key);
  if (!options?.refresh) {
    const cached = catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
    const inFlight = catalogPending.get(cacheKey);
    if (inFlight) return inFlight;
  }
  const request = fetchAllCatalogPages(key, credential).then((raw) => {
    const value = normalizeCatalogs(raw);
    catalogCache.set(cacheKey, { cachedAt: Date.now(), value });
    trackKey(key.connectionId, cacheKey);
    return value;
  });
  catalogPending.set(cacheKey, request);
  try {
    return await request;
  } finally {
    catalogPending.delete(cacheKey);
  }
}

/**
 * Lists every schema visible under `catalog` for the credential's service
 * principal. Cached 60s, keyed by the host identity plus `catalog`.
 */
export async function listDatabricksSchemas(
  key: DatabricksHostDiscoveryKey,
  credential: DatabricksHostCredential,
  catalog: string,
  options?: { refresh?: boolean },
): Promise<DatabricksSchemaOption[]> {
  assertValidHost(credential.host);
  if (!catalog.trim())
    throw new DatabricksDiscoveryError("unavailable", "A catalog is required to list its schemas");
  const cacheKey = `${serializeHostKey(key)}::${catalog}`;
  if (!options?.refresh) {
    const cached = schemaCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
    const inFlight = schemaPending.get(cacheKey);
    if (inFlight) return inFlight;
  }
  const request = fetchAllSchemaPages(key, credential, catalog).then((raw) => {
    const value = normalizeSchemas(raw, catalog);
    schemaCache.set(cacheKey, { cachedAt: Date.now(), value });
    trackKey(key.connectionId, cacheKey);
    return value;
  });
  schemaPending.set(cacheKey, request);
  try {
    return await request;
  } finally {
    schemaPending.delete(cacheKey);
  }
}

function normalizeCatalogs(raw: RawCatalog[]): DatabricksCatalogOption[] {
  const byName = new Map<string, DatabricksCatalogOption>();
  for (const entry of raw) {
    if (typeof entry.name !== "string" || !entry.name) continue;
    if (byName.has(entry.name)) continue;
    byName.set(entry.name, {
      name: entry.name,
      ...(typeof entry.comment === "string" && entry.comment ? { comment: entry.comment } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function normalizeSchemas(raw: RawSchema[], catalog: string): DatabricksSchemaOption[] {
  const byName = new Map<string, DatabricksSchemaOption>();
  for (const entry of raw) {
    if (typeof entry.name !== "string" || !entry.name) continue;
    if (byName.has(entry.name)) continue;
    const fullName = typeof entry.full_name === "string" && entry.full_name
      ? entry.full_name
      : `${catalog}.${entry.name}`;
    byName.set(entry.name, { name: entry.name, catalog, fullName });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function fetchAllCatalogPages(
  key: DatabricksHostDiscoveryKey,
  credential: DatabricksHostCredential,
): Promise<RawCatalog[]> {
  const items: RawCatalog[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const { token } = await resolveDatabricksAccessToken(tokenKey(key), credential);
    const page = await fetchCatalogsPage(credential, token, pageToken);
    if (Array.isArray(page.catalogs)) items.push(...page.catalogs);
    pageToken = page.next_page_token && page.next_page_token.length > 0 ? page.next_page_token : undefined;
    pages += 1;
    if (pageToken && pages >= MAX_CONSECUTIVE_PAGES)
      throw new DatabricksDiscoveryError(
        "unavailable",
        "Databricks workspace paginated past the allowed limit without completing",
      );
  } while (pageToken);
  return items;
}

async function fetchAllSchemaPages(
  key: DatabricksHostDiscoveryKey,
  credential: DatabricksHostCredential,
  catalog: string,
): Promise<RawSchema[]> {
  const items: RawSchema[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const { token } = await resolveDatabricksAccessToken(tokenKey(key), credential);
    const page = await fetchSchemasPage(credential, catalog, token, pageToken);
    if (Array.isArray(page.schemas)) items.push(...page.schemas);
    pageToken = page.next_page_token && page.next_page_token.length > 0 ? page.next_page_token : undefined;
    pages += 1;
    if (pageToken && pages >= MAX_CONSECUTIVE_PAGES)
      throw new DatabricksDiscoveryError(
        "unavailable",
        "Databricks workspace paginated past the allowed limit without completing",
      );
  } while (pageToken);
  return items;
}

async function fetchCatalogsPage(
  credential: DatabricksHostCredential,
  accessToken: string,
  pageToken: string | undefined,
): Promise<CatalogsPage> {
  const url = new URL("/api/2.1/unity-catalog/catalogs", credential.host);
  url.searchParams.set("max_results", String(MAX_RESULTS_PER_PAGE));
  if (pageToken) url.searchParams.set("page_token", pageToken);
  return requestPage(url, accessToken);
}

async function fetchSchemasPage(
  credential: DatabricksHostCredential,
  catalog: string,
  accessToken: string,
  pageToken: string | undefined,
): Promise<SchemasPage> {
  const url = new URL("/api/2.1/unity-catalog/schemas", credential.host);
  url.searchParams.set("catalog_name", catalog);
  url.searchParams.set("max_results", String(MAX_RESULTS_PER_PAGE));
  if (pageToken) url.searchParams.set("page_token", pageToken);
  return requestPage(url, accessToken);
}

async function requestPage<T>(url: URL, accessToken: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw mapNetworkError(error);
  }
  if (!response.ok) throw await mapHttpErrorStatus(response);
  return readBoundedJson<T>(response);
}

async function readBoundedJson<T>(response: Response): Promise<T> {
  if (!response.body) return {} as T;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new DatabricksDiscoveryError(
          "unavailable",
          "Databricks workspace returned a response that exceeded the processing limit",
        );
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(parts).toString("utf8");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks workspace returned a malformed response",
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
  await response.body?.cancel().catch(() => {});
  if (response.status === 401)
    return new DatabricksDiscoveryError("invalid_credential", "Databricks rejected the connection's credential");
  if (response.status === 403)
    return new DatabricksDiscoveryError(
      "insufficient_permission",
      "Databricks credential lacks permission for this request",
    );
  if (response.status === 429)
    return new DatabricksDiscoveryError(
      "rate_limited",
      "Databricks is rate limiting this connection",
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  if (response.status >= 500)
    return new DatabricksDiscoveryError("unavailable", "Databricks workspace is temporarily unavailable");
  return new DatabricksDiscoveryError("unavailable", "Databricks workspace returned an unexpected error");
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
  if (!isOriginOnly)
    throw new DatabricksDiscoveryError(
      "invalid_host",
      "Databricks workspace host must be an https:// origin with no path, query, or credentials",
    );
}

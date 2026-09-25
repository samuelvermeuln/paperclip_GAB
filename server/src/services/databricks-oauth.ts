import {
  DatabricksDiscoveryError,
  type DatabricksDiscoveryKey,
} from "./databricks-model-services.js";

/**
 * Sole owner of the Databricks OAuth 2.0 Machine-to-Machine (client
 * credentials) token exchange and of the short-lived access-token cache.
 *
 * A `clientId`/`clientSecret` pair is traded for a workspace access token via
 * `POST {host}/oidc/v1/token`; the resulting token is cached with a TTL that
 * expires ahead of the real `expires_in` so a token is never handed out once
 * it is within the safety margin of expiry.
 *
 * Error classification reuses `DatabricksDiscoveryError` /
 * `DatabricksDiscoveryErrorKind` from `databricks-model-services.ts`. Every
 * failure message is a fixed, generic string per `kind` — it never
 * interpolates the `clientSecret`, the issued token, response bodies, or
 * headers, so a secret can never leak into a thrown error. Nothing in this
 * module is ever logged.
 */

/** A service-principal OAuth M2M credential for one Databricks workspace. */
export interface DatabricksOAuthCredentialInput {
  /** Origin only, e.g. "https://acme.cloud.databricks.com". Never logged. */
  host: string;
  clientId: string;
  /** Resolved server-side only, never logged. */
  clientSecret: string;
}

/** A resolved workspace access token and its computed expiry. */
export interface DatabricksAccessToken {
  /** The bearer access token. Never logged. */
  token: string;
  /**
   * Epoch ms. The cache treats the token as expired `EXPIRY_MARGIN_MS` before
   * this instant, so a reused token always has real lifetime left.
   */
  expiresAt: number;
}

const TOKEN_ENDPOINT_PATH = "/oidc/v1/token";
const REQUEST_TIMEOUT_MS = 10_000;
/** A cached token is only reused while it has more than this much life left. */
const EXPIRY_MARGIN_MS = 60_000;
/** Defensive cap on the token response body; OIDC token responses are tiny JSON. */
const MAX_RESPONSE_BYTES = 64 * 1024;

interface TokenResponseBody {
  access_token?: unknown;
  expires_in?: unknown;
}

/** connectionId -> full token cache key. Never expires implicitly. */
const cache = new Map<string, DatabricksAccessToken>();
/** Coalesces concurrent identical exchanges so a stampede issues one call. */
const pending = new Map<string, Promise<DatabricksAccessToken>>();
/** connectionId -> set of full cache keys, so invalidation is scoped without a full scan. */
const keysByConnectionId = new Map<string, Set<string>>();

/**
 * The token cache identity: a token is valid for the whole workspace, so it is
 * keyed only by `companyId + connectionId + credentialVersion + host` — never
 * by `catalog`/`schema`/`modelPrefix`, which scope combo discovery, not auth.
 */
function serializeKey(key: DatabricksDiscoveryKey): string {
  return JSON.stringify([
    key.companyId,
    key.connectionId,
    key.credentialVersion ?? null,
    key.host,
  ]);
}

function trackKey(key: DatabricksDiscoveryKey, cacheKey: string): void {
  const set = keysByConnectionId.get(key.connectionId) ?? new Set<string>();
  set.add(cacheKey);
  keysByConnectionId.set(key.connectionId, set);
}

/**
 * Trades a Databricks service-principal `clientId`/`clientSecret` for a
 * workspace access token via `POST {host}/oidc/v1/token` with
 * `grant_type=client_credentials` and HTTP Basic auth. Bounded by a 10s
 * timeout, with no implicit retry — a failure propagates a classified
 * `DatabricksDiscoveryError` and any retry policy is the caller's to decide.
 *
 * Never includes the `clientSecret`, the issued token, or the response body in
 * a thrown message; never logs.
 */
export async function fetchDatabricksAccessToken(
  input: DatabricksOAuthCredentialInput,
): Promise<DatabricksAccessToken> {
  const url = new URL(TOKEN_ENDPOINT_PATH, input.host);
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw mapNetworkError(error);
  }

  if (!response.ok) throw await mapHttpErrorStatus(response);

  const body = await readBoundedJson(response);
  return toAccessToken(body);
}

/**
 * Resolves an access token for `key`
 * (`companyId + connectionId + credentialVersion + host`), reusing a cached
 * token while it has more than `EXPIRY_MARGIN_MS` of life left, otherwise
 * exchanging a fresh one. Concurrent calls for the same `key` coalesce into a
 * single in-flight exchange (the same `pending` pattern as
 * `databricks-model-services.ts`). `forceRefresh` bypasses the cache read.
 *
 * Invariant: never returns a token whose `expiresAt` is already past (or within
 * the safety margin of now) from the cache — such an entry triggers a fresh
 * exchange instead.
 */
export async function resolveDatabricksAccessToken(
  key: DatabricksDiscoveryKey,
  credential: DatabricksOAuthCredentialInput,
  options?: { forceRefresh?: boolean },
): Promise<DatabricksAccessToken> {
  const cacheKey = serializeKey(key);

  if (!options?.forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return cached;
    const inFlight = pending.get(cacheKey);
    if (inFlight) return inFlight;
  }

  const request = fetchDatabricksAccessToken(credential).then((token) => {
    cache.set(cacheKey, token);
    trackKey(key, cacheKey);
    return token;
  });
  pending.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pending.delete(cacheKey);
  }
}

/**
 * Invalidates every cached token for a connection, across all credential
 * versions. Called on reconnect/rotate/revoke — same pattern as
 * `invalidateDatabricksModelServiceCache`.
 */
export function invalidateDatabricksAccessToken(connectionId: string): void {
  const keys = keysByConnectionId.get(connectionId);
  if (!keys) return;
  for (const cacheKey of keys) {
    cache.delete(cacheKey);
    pending.delete(cacheKey);
  }
  keysByConnectionId.delete(connectionId);
}

/**
 * Reads the OIDC token response and derives `{ token, expiresAt }`. A missing
 * or malformed `access_token`/`expires_in` is treated as `unavailable`; the
 * body is never echoed into the error.
 */
function toAccessToken(body: TokenResponseBody): DatabricksAccessToken {
  const token = body.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks did not return a usable access token",
    );
  }
  const expiresInSeconds = Number(body.expires_in);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks did not return a usable access token",
    );
  }
  return { token, expiresAt: Date.now() + expiresInSeconds * 1000 };
}

function mapNetworkError(error: unknown): DatabricksDiscoveryError {
  if (error instanceof DatabricksDiscoveryError) return error;
  const isAbort = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new DatabricksDiscoveryError(
    "unavailable",
    isAbort
      ? "Databricks did not respond in time"
      : "Databricks could not be reached",
  );
}

async function mapHttpErrorStatus(response: Response): Promise<DatabricksDiscoveryError> {
  // Drain and discard the body without ever including it in a message; OAuth
  // error bodies can echo request context and must never be logged or surfaced.
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
      "Databricks credential lacks permission to issue a token",
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
      "Databricks is temporarily unavailable",
    );
  }
  return new DatabricksDiscoveryError(
    "unavailable",
    "Databricks returned an unexpected error while issuing a token",
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

/** Reads the body up to a bounded size, then parses it as JSON. */
async function readBoundedJson(response: Response): Promise<TokenResponseBody> {
  if (!response.body) {
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks did not return a usable access token",
    );
  }
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
          "Databricks returned a token response that exceeded the processing limit",
        );
      }
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(parts).toString("utf8");
  if (!text) {
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks did not return a usable access token",
    );
  }
  try {
    return JSON.parse(text) as TokenResponseBody;
  } catch {
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks returned a malformed token response",
    );
  }
}

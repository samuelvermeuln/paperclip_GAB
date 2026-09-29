import { logger } from "../middleware/logger.js";
import {
  DatabricksDiscoveryError,
  type DatabricksDiscoveryKey,
} from "./databricks-model-services.js";

/**
 * Sole owner of the Databricks OAuth 2.0 Machine-to-Machine (client
 * credentials) token exchange and of the short-lived access-token cache.
 *
 * A `clientId`/`clientSecret` pair is traded for a workspace access token via
 * `POST {host}/oidc/v1/token` with an explicit `scope=unity-catalog` (see
 * `TOKEN_SCOPE`) — never the implicit default Databricks grants when `scope`
 * is omitted (`all-apis`). A service-principal secret whose allowed scopes a
 * workspace admin has restricted to only `unity-catalog` rejects an unscoped
 * request outright; requesting the narrower scope explicitly is what the
 * discovery flow actually needs and is what a secret scoped that way permits
 * (`paperclip-diagnostico-oauth-databricks.md`). The resulting token is
 * cached with a TTL that expires ahead of the real `expires_in` so a token is
 * never handed out once it is within the safety margin of expiry.
 *
 * Error classification reuses `DatabricksDiscoveryError` /
 * `DatabricksDiscoveryErrorKind` from `databricks-model-services.ts`. Every
 * failure message thrown to a caller is a fixed, generic string per `kind` —
 * it never interpolates the `clientSecret`, the issued token, response
 * bodies, or headers, so a secret can never leak into a thrown error.
 *
 * A failure additionally emits one `databricks.oauth.failed` structured log
 * event (via the shared `logger`) before the classified error is thrown, and
 * a success emits one minimal `databricks.oauth.succeeded` event. Both use a
 * fixed field allowlist (see `DatabricksOAuthFailureEvent`) — never a raw
 * error object, response body, or header — so the credential and token can
 * never leak into a log line either.
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

/** Where the `clientId`/`clientSecret` being exchanged originated — for
 * diagnostics only, never for an authorization decision. */
export type DatabricksOAuthCredentialSource =
  | "request" // submitted directly on the current HTTP request (e.g. a discovery-session draft)
  | "stored_connection" // resolved from an already-saved AI connection's encrypted secret
  | "environment"; // reserved for a server-side fallback credential; unused today

/** Non-sensitive correlation context threaded through purely for the
 * structured diagnostics this module emits on failure. Every field here is
 * safe to log: no credential, no token. Optional and best-effort — a caller
 * that omits it still gets a classified error, just a less-correlated log
 * line. */
export interface DatabricksOAuthRequestContext {
  /** Correlates this OAuth attempt with the local HTTP request's own log lines. */
  requestId?: string;
  credentialSource?: DatabricksOAuthCredentialSource;
}

const TOKEN_ENDPOINT_PATH = "/oidc/v1/token";
/**
 * The scope requested for every discovery-purpose token exchange in this
 * module. Every current caller (catalog/schema/combo discovery, discovery
 * drafts, and connection-create credential validation) only ever needs Unity
 * Catalog access, so this scope is fixed rather than caller-configurable —
 * matching the Databricks-documented discovery scope, not the broader
 * `all-apis` example from the OAuth M2M guide. Runtime/inference token
 * minting is a separate module and is unaffected by this constant.
 */
const TOKEN_SCOPE = "unity-catalog";
const REQUEST_TIMEOUT_MS = 10_000;
/** A cached token is only reused while it has more than this much life left. */
const EXPIRY_MARGIN_MS = 60_000;
/** Defensive cap on the token response body; OIDC token responses are tiny JSON. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** `upstreamErrorDescription` is operator-facing diagnostics only; capped before
 * it ever reaches a log line. */
const MAX_ERROR_DESCRIPTION_LENGTH = 500;

interface TokenResponseBody {
  access_token?: unknown;
  expires_in?: unknown;
}

/** The standard OAuth 2.0 token-error response shape (RFC 6749 §5.2). Read
 * only to classify and to populate the sanitized `upstreamError`/
 * `upstreamErrorDescription` log fields — never surfaced verbatim to a caller. */
interface OAuthErrorBody {
  error?: unknown;
  error_description?: unknown;
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

/** The stage within the OAuth attempt (or the discovery draft it feeds) that a
 * failure occurred at — required by `paperclip-diagnostico-oauth-databricks.md`
 * so an operator never has to guess which step failed from a bare status code. */
export type DatabricksOAuthFailureStage =
  | "oauth_request" // the HTTP request to the token endpoint itself never completed (network/DNS/TLS/timeout)
  | "oauth_response" // a response arrived but its status was not 2xx
  | "oauth_parse" // a 2xx response arrived but its body could not be read/parsed/validated
  | "discovery_session"; // the token exchange succeeded; a step after it (e.g. persisting the draft) failed

/**
 * Every field a `databricks.oauth.failed` log line may carry — a fixed
 * allowlist, never a raw error object, response body, or header. `upstreamStatus`
 * is `null` when no HTTP response was ever received (`oauth_request`).
 */
interface DatabricksOAuthFailureEvent {
  requestId?: string;
  stage: DatabricksOAuthFailureStage;
  workspaceHost: string;
  endpointPath: string;
  method: "POST";
  scope: string;
  credentialSource?: DatabricksOAuthCredentialSource;
  durationMs: number;
  upstreamStatus: number | null;
  responseContentType?: string;
  upstreamError?: string;
  upstreamErrorDescription?: string;
  networkCode?: string;
  causeCode?: string;
  retryable: boolean;
}

function logOAuthFailure(fields: DatabricksOAuthFailureEvent): void {
  logger.warn({ event: "databricks.oauth.failed", ...fields }, "Databricks OAuth token exchange failed");
}

/**
 * Logs a `databricks.oauth.failed` event for `stage: "discovery_session"` —
 * a failure *after* the OAuth token exchange already succeeded (e.g.
 * persisting the discovery draft). Kept in this module so every stage of the
 * same attempt shares one sanitized, allowlisted event shape; the caller
 * (`databricks-discovery-sessions.ts`) never has to reimplement it. Never
 * retryable by default: an internal failure right after a successful OAuth
 * exchange needs an operator to look, not an automatic retry.
 */
export function logDatabricksOAuthDiscoverySessionFailure(input: {
  requestId?: string;
  workspaceHost: string;
  credentialSource?: DatabricksOAuthCredentialSource;
  durationMs: number;
  causeCode?: string;
}): void {
  logOAuthFailure({
    requestId: input.requestId,
    stage: "discovery_session",
    workspaceHost: input.workspaceHost,
    endpointPath: TOKEN_ENDPOINT_PATH,
    method: "POST",
    scope: TOKEN_SCOPE,
    credentialSource: input.credentialSource,
    durationMs: input.durationMs,
    upstreamStatus: null,
    causeCode: input.causeCode,
    retryable: false,
  });
}

function logOAuthSuccess(fields: {
  requestId?: string;
  workspaceHost: string;
  credentialSource?: DatabricksOAuthCredentialSource;
  durationMs: number;
  upstreamStatus: number;
}): void {
  // Success is logged with status/duration/token-presence only — never the
  // token value itself, per the spec's explicit success-logging rule.
  logger.info(
    { event: "databricks.oauth.succeeded", ...fields, hasToken: true },
    "Databricks OAuth token exchange succeeded",
  );
}

/**
 * Reduces an upstream OAuth `error_description` to something safe to put in a
 * log line: known secret values are redacted by literal substring match,
 * Basic/Bearer-shaped and JWT-shaped substrings are redacted by pattern, the
 * result is flattened to one line and capped at `MAX_ERROR_DESCRIPTION_LENGTH`.
 * If a long opaque token-shaped run still survives every redaction pass, the
 * whole description is omitted instead of risking a partial leak (per the
 * spec: "se não for seguro sanitizar, omitir a descrição").
 */
function sanitizeUpstreamErrorDescription(
  raw: unknown,
  knownSecrets: readonly string[],
): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let value = raw;
  for (const secret of knownSecrets) {
    if (secret) value = value.split(secret).join("[redacted]");
  }
  value = value.replace(/\b(basic|bearer)\s+[a-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  value = value.replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi, "[redacted]");
  value = value.replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim();
  if (!value) return undefined;
  if (value.length > MAX_ERROR_DESCRIPTION_LENGTH) value = `${value.slice(0, MAX_ERROR_DESCRIPTION_LENGTH)}…`;
  // A 24+ character run of token-shaped characters that survived every
  // redaction above still looks like a credential we failed to recognize;
  // omitting the whole field is safer than guessing it is inert.
  if (/[A-Za-z0-9+/_-]{24,}/.test(value)) return undefined;
  return value;
}

/** Reads a response body to bounded text without assuming its shape (JSON,
 * HTML, or plain text). `truncated` is true only when the body exceeded
 * `MAX_RESPONSE_BYTES`; the caller decides what that means for its stage. */
async function readBoundedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        truncated = true;
        break;
      }
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(parts).toString("utf8"), truncated };
}

/** Node's `fetch` (undici) surfaces DNS/TLS/connection failures as a
 * `TypeError` whose `.cause` carries the real `code` (e.g. `ENOTFOUND`,
 * `CERT_HAS_EXPIRED`, `ECONNRESET`). Extracted only as short codes for
 * logging — the exception and its cause are never serialized whole. */
function extractNetworkCodes(error: unknown): { networkCode?: string; causeCode?: string } {
  if (!(error instanceof Error)) return {};
  const causeCode =
    typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  const cause = (error as { cause?: unknown }).cause;
  const networkCode =
    cause && typeof cause === "object" && typeof (cause as NodeJS.ErrnoException).code === "string"
      ? (cause as NodeJS.ErrnoException).code
      : undefined;
  return { networkCode, causeCode };
}

/** Network-level codes that mean "this will keep failing until the host,
 * certificate, or DNS configuration changes" — never worth retrying as-is,
 * unlike a transient `ECONNRESET`/`ETIMEDOUT`. */
const NON_RETRYABLE_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Classifies a `fetch()`-level exception (the request never completed): a
 * timeout/abort, or a DNS/TLS/connection failure from the runtime. Retryable
 * decision follows the specific cause (spec: "DNS/TLS/conexão: código de
 * transporte específico; decidir retry conforme a causa"), not a blanket true.
 */
function classifyNetworkError(
  error: unknown,
): { error: DatabricksDiscoveryError; networkCode?: string; causeCode?: string } {
  if (error instanceof DatabricksDiscoveryError) return { error };
  const isAbort = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  if (isAbort) {
    return {
      error: new DatabricksDiscoveryError("unavailable", "Databricks did not respond in time", undefined, true),
      causeCode: error instanceof Error ? error.name : undefined,
    };
  }
  const { networkCode, causeCode } = extractNetworkCodes(error);
  const code = networkCode ?? causeCode;
  const retryable = code ? !NON_RETRYABLE_NETWORK_CODES.has(code) : true;
  return {
    error: new DatabricksDiscoveryError("unavailable", "Databricks could not be reached", undefined, retryable),
    networkCode,
    causeCode,
  };
}

/**
 * Classifies a non-2xx token-endpoint response. Reads the body once (bounded)
 * and, when it parses as the standard OAuth 2.0 error shape, uses `error` to
 * distinguish an explicit `invalid_client`/`invalid_scope` rejection from
 * every other case — the fallback classification (`upstream_rejected`) never
 * assumes the credential itself was wrong. `error`/`error_description` are
 * only ever surfaced through the sanitized, capped log fields, never in a
 * thrown message.
 */
async function classifyErrorResponse(
  response: Response,
  clientSecret: string,
): Promise<{
  error: DatabricksDiscoveryError;
  upstreamError?: string;
  upstreamErrorDescription?: string;
  bodyTruncated: boolean;
}> {
  const { text, truncated } = await readBoundedText(response);
  let parsed: OAuthErrorBody | null = null;
  if (text) {
    try {
      const candidate = JSON.parse(text) as unknown;
      if (candidate && typeof candidate === "object") parsed = candidate as OAuthErrorBody;
    } catch {
      parsed = null;
    }
  }
  const oauthError = typeof parsed?.error === "string" ? parsed.error.slice(0, 64) : undefined;
  const upstreamErrorDescription = sanitizeUpstreamErrorDescription(parsed?.error_description, [clientSecret]);
  const retryAfter = response.headers.get("retry-after");

  let error: DatabricksDiscoveryError;
  if (oauthError === "invalid_scope") {
    error = new DatabricksDiscoveryError(
      "scope_rejected",
      "Databricks rejected the OAuth scope requested for this credential",
      undefined,
      false,
    );
  } else if (response.status === 401 || oauthError === "invalid_client" || oauthError === "unauthorized_client") {
    error = new DatabricksDiscoveryError(
      "invalid_credential",
      "Databricks rejected the connection's credential",
      undefined,
      false,
    );
  } else if (response.status === 403) {
    error = new DatabricksDiscoveryError(
      "insufficient_permission",
      "Databricks credential lacks permission to issue a token",
      undefined,
      false,
    );
  } else if (response.status === 429) {
    error = new DatabricksDiscoveryError(
      "rate_limited",
      "Databricks is rate limiting this connection",
      parseRetryAfterSeconds(retryAfter),
      true,
    );
  } else if (response.status >= 500) {
    error = new DatabricksDiscoveryError("unavailable", "Databricks is temporarily unavailable", undefined, true);
  } else {
    error = new DatabricksDiscoveryError(
      "upstream_rejected",
      "Databricks rejected the token request with an unexpected response",
      undefined,
      false,
    );
  }
  return { error, upstreamError: oauthError, upstreamErrorDescription, bodyTruncated: truncated };
}

/**
 * Trades a Databricks service-principal `clientId`/`clientSecret` for a
 * workspace access token via `POST {host}/oidc/v1/token` with
 * `grant_type=client_credentials` and HTTP Basic auth. Bounded by a 10s
 * timeout, with no implicit retry — a failure propagates a classified
 * `DatabricksDiscoveryError` and any retry policy is the caller's to decide.
 *
 * Never includes the `clientSecret`, the issued token, or the response body in
 * a thrown message. Emits exactly one sanitized, allowlisted structured log
 * event per attempt (`databricks.oauth.failed` or `.succeeded`) — see the
 * module doc comment.
 */
export async function fetchDatabricksAccessToken(
  input: DatabricksOAuthCredentialInput,
  context: DatabricksOAuthRequestContext = {},
): Promise<DatabricksAccessToken> {
  const url = new URL(TOKEN_ENDPOINT_PATH, input.host);
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: TOKEN_SCOPE }).toString();
  const startedAt = Date.now();
  const baseEvent = {
    requestId: context.requestId,
    workspaceHost: input.host,
    endpointPath: TOKEN_ENDPOINT_PATH,
    method: "POST" as const,
    scope: TOKEN_SCOPE,
    credentialSource: context.credentialSource,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const { error: classified, networkCode, causeCode } = classifyNetworkError(error);
    logOAuthFailure({
      ...baseEvent,
      stage: "oauth_request",
      durationMs: Date.now() - startedAt,
      upstreamStatus: null,
      networkCode,
      causeCode,
      retryable: classified.retryable ?? true,
    });
    throw classified;
  }

  const durationMs = Date.now() - startedAt;
  const responseContentType = response.headers.get("content-type") ?? undefined;

  if (!response.ok) {
    const { error, upstreamError, upstreamErrorDescription } = await classifyErrorResponse(
      response,
      input.clientSecret,
    );
    logOAuthFailure({
      ...baseEvent,
      stage: "oauth_response",
      durationMs,
      upstreamStatus: response.status,
      responseContentType,
      upstreamError,
      upstreamErrorDescription,
      retryable: error.retryable ?? defaultRetryableForKind(error.kind),
    });
    throw error;
  }

  const { text, truncated } = await readBoundedText(response);
  if (truncated) {
    logOAuthFailure({
      ...baseEvent,
      stage: "oauth_parse",
      durationMs,
      upstreamStatus: response.status,
      responseContentType,
      retryable: true,
    });
    throw new DatabricksDiscoveryError(
      "unavailable",
      "Databricks returned a token response that exceeded the processing limit",
    );
  }

  let parsedBody: TokenResponseBody;
  try {
    parsedBody = text ? (JSON.parse(text) as TokenResponseBody) : {};
  } catch {
    logOAuthFailure({
      ...baseEvent,
      stage: "oauth_parse",
      durationMs,
      upstreamStatus: response.status,
      responseContentType,
      retryable: true,
    });
    throw new DatabricksDiscoveryError("unavailable", "Databricks returned a malformed token response");
  }

  let token: DatabricksAccessToken;
  try {
    token = toAccessToken(parsedBody);
  } catch (error) {
    logOAuthFailure({
      ...baseEvent,
      stage: "oauth_parse",
      durationMs,
      upstreamStatus: response.status,
      responseContentType,
      retryable: true,
    });
    throw error;
  }

  logOAuthSuccess({
    requestId: context.requestId,
    workspaceHost: input.host,
    credentialSource: context.credentialSource,
    durationMs,
    upstreamStatus: response.status,
  });
  return token;
}

/** The retryable default for a `kind` that did not carry an explicit
 * per-instance override (see `DatabricksDiscoveryError.retryable`'s doc). */
function defaultRetryableForKind(kind: DatabricksDiscoveryError["kind"]): boolean {
  return kind === "rate_limited" || kind === "unavailable";
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
  options?: { forceRefresh?: boolean; context?: DatabricksOAuthRequestContext },
): Promise<DatabricksAccessToken> {
  const cacheKey = serializeKey(key);

  if (!options?.forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return cached;
    const inFlight = pending.get(cacheKey);
    if (inFlight) return inFlight;
  }

  const request = fetchDatabricksAccessToken(credential, options?.context).then((token) => {
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

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  return undefined;
}

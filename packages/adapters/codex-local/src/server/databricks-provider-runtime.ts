// Builds the PAPERCLIP_CODEX_PROVIDERS JSON payload for a Databricks Unity
// Gateway run, from the `providerRuntimeHint` the server's
// `prepareManagedAiRuntime` (server/src/services/ai-connection-runtime.ts)
// attaches to `config` when the resolved AI Connection binding's provider is
// "databricks". Kept as a standalone, pure function (no fs/process access)
// so it can be unit tested without spawning a real Codex process.
//
// Requirements 4.1/4.2: the payload authenticates via an `auth.command` helper
// that mints a short-lived OAuth M2M access token at runtime. The hint carries
// only the helper's absolute command, its args, and its timeouts -- never an
// `env_key`, a literal token, or any other secret value.

export interface DatabricksProviderRuntimeHint {
  provider: "databricks";
  baseUrl: string;
  wireApi: "responses";
  /** Absolute path of the installed helper binary; never resolved via PATH. */
  authCommand: string;
  authArgs: string[];
  authTimeoutMs: number;
  authRefreshIntervalMs: number;
}

function isDatabricksProviderRuntimeHint(
  value: unknown,
): value is DatabricksProviderRuntimeHint {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "databricks" &&
    typeof (value as { baseUrl?: unknown }).baseUrl === "string" &&
    typeof (value as { wireApi?: unknown }).wireApi === "string" &&
    typeof (value as { authCommand?: unknown }).authCommand === "string" &&
    Array.isArray((value as { authArgs?: unknown }).authArgs) &&
    (value as { authArgs: unknown[] }).authArgs.every(
      (arg) => typeof arg === "string",
    ) &&
    typeof (value as { authTimeoutMs?: unknown }).authTimeoutMs === "number" &&
    typeof (value as { authRefreshIntervalMs?: unknown })
      .authRefreshIntervalMs === "number"
  );
}

/** Reads and validates `config.providerRuntimeHint`, returning it only when it is a
 * well-formed Databricks hint. */
export function readDatabricksProviderRuntimeHint(
  config: Record<string, unknown>,
): DatabricksProviderRuntimeHint | null {
  const hint = config.providerRuntimeHint;
  return isDatabricksProviderRuntimeHint(hint) ? hint : null;
}

/** Builds the PAPERCLIP_CODEX_PROVIDERS JSON payload that routes this run's Codex
 * process at the workspace's Unity Gateway instead of OpenAI. */
export function buildDatabricksProvidersPayload(
  hint: DatabricksProviderRuntimeHint,
): string {
  return JSON.stringify({
    providers: {
      databricks: {
        name: "Databricks Unity Gateway",
        base_url: hint.baseUrl,
        wire_api: hint.wireApi,
        supports_websockets: false,
        auth: {
          command: hint.authCommand,
          args: hint.authArgs,
          timeout_ms: hint.authTimeoutMs,
          refresh_interval_ms: hint.authRefreshIntervalMs,
        },
      },
    },
    model_provider: "databricks",
  });
}

/**
 * Given the run's string-valued env map and the adapter config, returns the
 * env map to hand to `prepareCodexRuntimeConfig`, with `PAPERCLIP_CODEX_PROVIDERS`
 * set to the Databricks payload when a Databricks `providerRuntimeHint` is
 * present.
 *
 * A Databricks hint always wins over any pre-existing
 * `PAPERCLIP_CODEX_PROVIDERS` value: Databricks routing is authoritative for a
 * run whose AI Connection binding resolved to `provider: "databricks"`, since
 * that resolution already determined the run must talk to the workspace's
 * Unity Gateway. This mirrors how other managed-AI-connection providers (e.g.
 * OpenAI api_key) already take precedence over ambient/user-supplied
 * provider env for a managed run.
 */
export function buildDatabricksProviderRuntimeEnv(
  envConfigStrings: Record<string, string>,
  config: Record<string, unknown>,
): Record<string, string> {
  const hint = readDatabricksProviderRuntimeHint(config);
  if (!hint) return envConfigStrings;
  return {
    ...envConfigStrings,
    PAPERCLIP_CODEX_PROVIDERS: buildDatabricksProvidersPayload(hint),
  };
}

// --- Connectivity check (Test tab / environment probe) ----------------------
//
// `packages/adapters/codex-local` is a standalone, independently publishable
// package (see its `publishConfig`) that never depends on `server/src/*`. The
// authoritative Unity Catalog discovery error classification —
// `DatabricksDiscoveryErrorKind` / `DatabricksDiscoveryError` — lives in
// `server/src/services/databricks-model-services.ts` and cannot be imported
// here. `DatabricksConnectivityCheckKind` below is a deliberate, parallel
// classification: same kind names/semantics (401 -> invalid credential, 403 ->
// insufficient permission, 429 -> rate limited with Retry-After, 5xx/timeout ->
// unavailable), reimplemented locally so `test.ts` can classify a connectivity
// probe without a cross-package/server-layer dependency.

export type DatabricksConnectivityCheckKind =
  | "reachable"
  | "invalid_credential" // 401
  | "insufficient_permission" // 403
  | "rate_limited" // 429, carries retryAfterSeconds
  | "unavailable"; // 5xx / network / timeout

export interface DatabricksConnectivityCheckResult {
  kind: DatabricksConnectivityCheckKind;
  retryAfterSeconds?: number;
}

const DATABRICKS_CONNECTIVITY_TIMEOUT_MS = 10_000;

/**
 * Minimal connectivity check against a run's Unity Gateway `baseUrl`
 * (`<workspaceHost>/ai-gateway/codex/v1`). Deliberately issues a plain `GET`
 * to the base path rather than a `POST .../responses` request: the gateway
 * enforces authentication/authorization before routing to a specific
 * operation, so an unauthenticated/forbidden/rate-limited credential is still
 * classified correctly from a `GET`, while a real (billed) model completion
 * is never invoked just to test connectivity. Any response the gateway
 * returns without a 401/403/429/5xx status (including a 404/405 "wrong
 * method" response for a POST-only route) is treated as `reachable`, since it
 * proves the request passed auth and routing. This is a deliberate tradeoff:
 * it favors a free, fast check over perfectly emulating the real request
 * shape, and never sends a prompt or consumes model-inference quota.
 *
 * Never throws: network/timeout failures are classified as `unavailable`
 * rather than propagated, so the caller always gets a result to render.
 */
export async function checkDatabricksConnectivity(
  baseUrl: string,
  token: string,
): Promise<DatabricksConnectivityCheckResult> {
  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DATABRICKS_CONNECTIVITY_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return { kind: "unavailable" };
  }
  // Drain and discard the body without ever inspecting or surfacing it;
  // provider error bodies may echo request context and must never be logged.
  await response.body?.cancel().catch(() => {});

  if (response.status === 401) return { kind: "invalid_credential" };
  if (response.status === 403) return { kind: "insufficient_permission" };
  if (response.status === 429) {
    return {
      kind: "rate_limited",
      retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
    };
  }
  if (response.status >= 500) return { kind: "unavailable" };
  return { kind: "reachable" };
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  return undefined;
}

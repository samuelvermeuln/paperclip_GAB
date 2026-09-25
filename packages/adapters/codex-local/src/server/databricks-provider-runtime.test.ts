import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildDatabricksProviderRuntimeEnv,
  buildDatabricksProvidersPayload,
  checkDatabricksConnectivity,
  readDatabricksProviderRuntimeHint,
  type DatabricksProviderRuntimeHint,
} from "./databricks-provider-runtime.js";
import { prepareCodexRuntimeConfig } from "./runtime-config.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Absolute path to the installed OAuth M2M helper the run's provider payload
// invokes at request time (never resolved via PATH). The literal value is
// irrelevant to these tests as long as it is an absolute path, per the hint
// contract in databricks-provider-runtime.ts (Requirements 4.1/4.2).
const AUTH_COMMAND = "/opt/paperclip/bin/paperclip-databricks-oauth-token";

const HINT: DatabricksProviderRuntimeHint = {
  provider: "databricks",
  baseUrl: "https://acme.cloud.databricks.com/ai-gateway/codex/v1",
  wireApi: "responses",
  authCommand: AUTH_COMMAND,
  authArgs: [],
  authTimeoutMs: 5_000,
  authRefreshIntervalMs: 1_800_000,
};

describe("readDatabricksProviderRuntimeHint", () => {
  it("returns null when config has no providerRuntimeHint", () => {
    expect(readDatabricksProviderRuntimeHint({})).toBeNull();
  });

  it("returns null when providerRuntimeHint is for a different provider", () => {
    expect(
      readDatabricksProviderRuntimeHint({
        providerRuntimeHint: { provider: "openai", baseUrl: "https://x", wireApi: "responses" },
      }),
    ).toBeNull();
  });

  it("returns null when providerRuntimeHint is malformed", () => {
    expect(
      readDatabricksProviderRuntimeHint({
        providerRuntimeHint: { provider: "databricks" },
      }),
    ).toBeNull();
  });

  it("returns null when the OAuth M2M auth fields are missing", () => {
    // A hint carrying only the legacy shape (provider/baseUrl/wireApi) but none
    // of the required auth-helper fields must be rejected: it can no longer
    // produce a runnable Databricks provider payload.
    expect(
      readDatabricksProviderRuntimeHint({
        providerRuntimeHint: {
          provider: "databricks",
          baseUrl: HINT.baseUrl,
          wireApi: "responses",
        },
      }),
    ).toBeNull();
  });

  it("returns null when authArgs is not an array of strings", () => {
    expect(
      readDatabricksProviderRuntimeHint({
        providerRuntimeHint: { ...HINT, authArgs: [1, 2] },
      }),
    ).toBeNull();
  });

  it("returns the hint when it is a well-formed Databricks hint", () => {
    expect(readDatabricksProviderRuntimeHint({ providerRuntimeHint: HINT })).toEqual(HINT);
  });
});

describe("buildDatabricksProvidersPayload", () => {
  // Validates: Requirements 4.1, 4.2
  it("emits an auth.command block (never env_key or a literal secret), supports_websockets false, wire_api responses", () => {
    const payload = JSON.parse(buildDatabricksProvidersPayload(HINT));
    expect(payload).toEqual({
      providers: {
        databricks: {
          name: "Databricks Unity Gateway",
          base_url: HINT.baseUrl,
          wire_api: "responses",
          supports_websockets: false,
          auth: {
            command: HINT.authCommand,
            args: HINT.authArgs,
            timeout_ms: HINT.authTimeoutMs,
            refresh_interval_ms: HINT.authRefreshIntervalMs,
          },
        },
      },
      model_provider: "databricks",
    });

    const databricks = payload.providers.databricks;
    // No env_key indirection and no literal/static-token material anywhere in
    // the payload — auth is delegated entirely to the auth.command helper.
    expect(databricks).not.toHaveProperty("env_key");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("env_key");
    expect(serialized).not.toContain("DATABRICKS_TOKEN");
    // supports_websockets is always false; wire_api is always "responses".
    expect(databricks.supports_websockets).toBe(false);
    expect(databricks.wire_api).toBe("responses");
    // The auth section carries an absolute command, an args list, and positive
    // integer timeouts, and nothing else (no secret).
    expect(path.isAbsolute(databricks.auth.command)).toBe(true);
    expect(Array.isArray(databricks.auth.args)).toBe(true);
    expect(Number.isInteger(databricks.auth.timeout_ms)).toBe(true);
    expect(databricks.auth.timeout_ms).toBeGreaterThan(0);
    expect(Number.isInteger(databricks.auth.refresh_interval_ms)).toBe(true);
    expect(databricks.auth.refresh_interval_ms).toBeGreaterThan(0);
  });

  // Property 6: Somente o combo selecionado.
  // Validates: Requirements 4.3
  it("never carries a `model` field, so Paperclip cannot rewrite the selected combo id", () => {
    const payload = JSON.parse(buildDatabricksProvidersPayload(HINT));
    // The payload configures only the provider (base_url/auth/wire_api). The
    // model id is passed to Codex via its --model flag from the user-selected
    // combo, so the provider payload must never define or override `model`.
    expect(payload).not.toHaveProperty("model");
    expect(payload.providers.databricks).not.toHaveProperty("model");
  });
});

describe("buildDatabricksProviderRuntimeEnv", () => {
  it("passes the env through unmodified when there is no Databricks hint", () => {
    const env = { FOO: "bar" };
    expect(buildDatabricksProviderRuntimeEnv(env, {})).toBe(env);
  });

  it("sets PAPERCLIP_CODEX_PROVIDERS from the hint, overriding any pre-existing value", () => {
    const env = { FOO: "bar", PAPERCLIP_CODEX_PROVIDERS: "{\"providers\":{\"other\":{}}}" };
    const result = buildDatabricksProviderRuntimeEnv(env, { providerRuntimeHint: HINT });
    expect(result.FOO).toBe("bar");
    expect(JSON.parse(result.PAPERCLIP_CODEX_PROVIDERS)).toEqual({
      providers: {
        databricks: {
          name: "Databricks Unity Gateway",
          base_url: HINT.baseUrl,
          wire_api: "responses",
          supports_websockets: false,
          auth: {
            command: HINT.authCommand,
            args: HINT.authArgs,
            timeout_ms: HINT.authTimeoutMs,
            refresh_interval_ms: HINT.authRefreshIntervalMs,
          },
        },
      },
      model_provider: "databricks",
    });
  });
});

describe("buildDatabricksProviderRuntimeEnv + prepareCodexRuntimeConfig integration", () => {
  // Validates: Requirements 4.1, 4.2, 4.3 (Property 6 end-to-end)
  it("merges a [model_providers.databricks] table with the auth.command block and model_provider into config.toml, without rewriting `model`", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-databricks-"));
    try {
      const env = buildDatabricksProviderRuntimeEnv(
        // A token-like value in the run env must never surface in config.toml:
        // with no env_key indirection and no {env:...} placeholder, it cannot.
        { DATABRICKS_TOKEN: "fixture-token" },
        { providerRuntimeHint: HINT },
      );
      const prepared = await prepareCodexRuntimeConfig({ env, codexHome: home });
      const content = await fs.readFile(path.join(home, "config.toml"), "utf8");
      expect(content).toContain('model_provider = "databricks"');
      expect(content).toContain("[model_providers.databricks]");
      expect(content).toContain(`base_url = "${HINT.baseUrl}"`);
      expect(content).toContain('wire_api = "responses"');
      expect(content).toContain("supports_websockets = false");
      // The auth.command block is emitted as an inline TOML table; env_key is gone.
      expect(content).toContain(`command = "${HINT.authCommand}"`);
      expect(content).toContain("timeout_ms = 5000");
      expect(content).toContain("refresh_interval_ms = 1800000");
      expect(content).not.toContain("env_key");
      // Property 6: Paperclip merges the provider block but never writes a bare
      // `model = ...` key, so the user-selected combo id (handed to Codex via
      // its --model flag) is never rewritten or reinterpreted. Note this must
      // not false-match `model_provider = ...` or `[model_providers.*]`.
      expect(content).not.toMatch(/^\s*model\s*=/m);
      // No literal/static-token secret material ever reaches config.toml.
      expect(content).not.toContain("fixture-token");
      await prepared.cleanup();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("restores the pre-run config.toml on the next run after a crash that skips cleanup()", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-databricks-crash-"));
    try {
      const original = [
        'model = "gpt-5.1-codex"',
        "",
        "[profiles.dev]",
        'model = "gpt-5.1-codex-mini"',
        "",
      ].join("\n");
      await fs.writeFile(path.join(home, "config.toml"), original, "utf8");

      const env = buildDatabricksProviderRuntimeEnv(
        { DATABRICKS_TOKEN: "fixture-token" },
        { providerRuntimeHint: HINT },
      );
      // Simulate a crash: the merge writes the Databricks provider block and
      // a pre-run backup, but cleanup() never runs (the process dies before
      // the run's finally block executes).
      const crashed = await prepareCodexRuntimeConfig({ env, codexHome: home });
      void crashed;
      const crashedContent = await fs.readFile(path.join(home, "config.toml"), "utf8");
      expect(crashedContent).toContain('model_provider = "databricks"');
      expect(crashedContent).toContain("[model_providers.databricks]");
      expect(crashedContent).toContain(`command = "${HINT.authCommand}"`);
      expect(crashedContent).not.toContain("env_key");

      // The next run preparation (e.g. the following heartbeat tick) must
      // self-heal: restore the pre-Databricks content and remove every
      // Databricks-specific trace, before applying its own (here: none).
      const prepared = await prepareCodexRuntimeConfig({ env: {}, codexHome: home });
      const restored = await fs.readFile(path.join(home, "config.toml"), "utf8");
      expect(restored).toBe(original);
      expect(restored).not.toContain("DATABRICKS_TOKEN");
      expect(restored).not.toContain(HINT.baseUrl);
      expect(restored).not.toContain('model_provider = "databricks"');
      await expect(
        fs.access(path.join(home, "config.toml.paperclip-backup")),
      ).rejects.toThrow();
      await prepared.cleanup();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("checkDatabricksConnectivity", () => {
  const BASE_URL = "https://acme.cloud.databricks.com/ai-gateway/codex/v1";
  const TOKEN = "dapi-secret-token-value";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Response | (() => Promise<Response>)) {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        typeof response === "function" ? response() : response,
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends a bearer-token GET to the base URL and classifies a 200 as reachable", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 200 }));
    const result = await checkDatabricksConnectivity(BASE_URL, TOKEN);
    expect(result).toEqual({ kind: "reachable" });
    expect(fetchMock).toHaveBeenCalledWith(
      BASE_URL,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
  });

  it("classifies a 404/405 (wrong-method-but-authenticated) response as reachable", async () => {
    stubFetch(new Response(null, { status: 405 }));
    expect(await checkDatabricksConnectivity(BASE_URL, TOKEN)).toEqual({ kind: "reachable" });
  });

  it("classifies 401 as invalid_credential", async () => {
    stubFetch(new Response(null, { status: 401 }));
    expect(await checkDatabricksConnectivity(BASE_URL, TOKEN)).toEqual({ kind: "invalid_credential" });
  });

  it("classifies 403 as insufficient_permission", async () => {
    stubFetch(new Response(null, { status: 403 }));
    expect(await checkDatabricksConnectivity(BASE_URL, TOKEN)).toEqual({ kind: "insufficient_permission" });
  });

  it("classifies 429 as rate_limited and captures Retry-After when present", async () => {
    stubFetch(new Response(null, { status: 429, headers: { "retry-after": "30" } }));
    expect(await checkDatabricksConnectivity(BASE_URL, TOKEN)).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 30,
    });
  });

  it("classifies 429 with no Retry-After as rate_limited with no retryAfterSeconds", async () => {
    stubFetch(new Response(null, { status: 429 }));
    expect(await checkDatabricksConnectivity(BASE_URL, TOKEN)).toEqual({ kind: "rate_limited" });
  });

  it("classifies a 5xx as unavailable", async () => {
    stubFetch(new Response(null, { status: 503 }));
    expect(await checkDatabricksConnectivity(BASE_URL, TOKEN)).toEqual({ kind: "unavailable" });
  });

  it("classifies a network/timeout failure as unavailable without throwing", async () => {
    stubFetch(() => Promise.reject(new Error("fetch failed")));
    expect(await checkDatabricksConnectivity(BASE_URL, TOKEN)).toEqual({ kind: "unavailable" });
  });

  it("never includes the token in the request URL", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 200 }));
    await checkDatabricksConnectivity(BASE_URL, TOKEN);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain(TOKEN);
  });
});

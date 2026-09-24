import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildDatabricksProviderRuntimeEnv,
  buildDatabricksProvidersPayload,
  checkDatabricksConnectivity,
  readDatabricksProviderRuntimeHint,
} from "./databricks-provider-runtime.js";
import { prepareCodexRuntimeConfig } from "./runtime-config.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HINT = {
  provider: "databricks" as const,
  baseUrl: "https://acme.cloud.databricks.com/ai-gateway/codex/v1",
  wireApi: "responses",
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

  it("returns the hint when it is a well-formed Databricks hint", () => {
    expect(readDatabricksProviderRuntimeHint({ providerRuntimeHint: HINT })).toEqual(HINT);
  });
});

describe("buildDatabricksProvidersPayload", () => {
  it("builds a PAPERCLIP_CODEX_PROVIDERS payload with env_key indirection only, never a literal token", () => {
    const payload = JSON.parse(buildDatabricksProvidersPayload(HINT));
    expect(payload).toEqual({
      providers: {
        databricks: {
          name: "Databricks Unity Gateway",
          base_url: HINT.baseUrl,
          env_key: "DATABRICKS_TOKEN",
          wire_api: HINT.wireApi,
        },
      },
      model_provider: "databricks",
    });
    expect(JSON.stringify(payload)).not.toContain("DATABRICKS_TOKEN_VALUE");
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
          env_key: "DATABRICKS_TOKEN",
          wire_api: HINT.wireApi,
        },
      },
      model_provider: "databricks",
    });
  });
});

describe("buildDatabricksProviderRuntimeEnv + prepareCodexRuntimeConfig integration", () => {
  it("merges a [model_providers.databricks] table with the expected fields and model_provider into config.toml", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-databricks-"));
    try {
      const env = buildDatabricksProviderRuntimeEnv(
        { DATABRICKS_TOKEN: "fixture-token" },
        { providerRuntimeHint: HINT },
      );
      const prepared = await prepareCodexRuntimeConfig({ env, codexHome: home });
      const content = await fs.readFile(path.join(home, "config.toml"), "utf8");
      expect(content).toContain('model_provider = "databricks"');
      expect(content).toContain("[model_providers.databricks]");
      expect(content).toContain(`base_url = "${HINT.baseUrl}"`);
      expect(content).toContain('env_key = "DATABRICKS_TOKEN"');
      expect(content).toContain('wire_api = "responses"');
      // The literal token value must never appear in config.toml.
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
      expect(crashedContent).toContain('env_key = "DATABRICKS_TOKEN"');

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

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runProcessMock = vi.hoisted(() => vi.fn());
const maybeRunSandboxInstallCommandMock = vi.hoisted(() => vi.fn(async () => null));
const resolveCodexExecutionEngineForRunMock = vi.hoisted(() =>
  vi.fn(async () => ({ engine: "cli" as const })),
);

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetDirectory: ensureDirectoryMock,
  maybeRunSandboxInstallCommand: maybeRunSandboxInstallCommandMock,
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

vi.mock("./acp.js", () => ({
  resolveCodexExecutionEngineForRun: resolveCodexExecutionEngineForRunMock,
  testCodexAcpEnvironment: vi.fn(),
}));

import { testEnvironment } from "./test.js";

const DATABRICKS_BASE_URL = "https://acme.cloud.databricks.com/ai-gateway/codex/v1";
const DATABRICKS_TOKEN = "dapi-secret-token-value";

function databricksConfig(env: Record<string, string> = {}) {
  return {
    command: "codex",
    cwd: "/tmp/project",
    providerRuntimeHint: {
      provider: "databricks" as const,
      baseUrl: DATABRICKS_BASE_URL,
      wireApi: "responses",
    },
    env: { DATABRICKS_TOKEN, ...env },
  };
}

describe("codex_local testEnvironment (Databricks connectivity path)", () => {
  beforeEach(() => {
    ensureDirectoryMock.mockClear();
    ensureCommandMock.mockClear();
    runProcessMock.mockReset();
    maybeRunSandboxInstallCommandMock.mockClear();
    resolveCodexExecutionEngineForRunMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, headers?: Record<string, string>) {
    const fetchMock = vi.fn(async () => new Response(null, { status, headers }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("passes with databricks_connectivity_passed on a reachable (2xx/404/405-shaped) response", async () => {
    const fetchMock = stubFetch(200);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);

    expect(result.status).toBe("pass");
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("databricks_connectivity_passed");
    expect(codes).not.toContain("codex_openai_api_key_present");
    expect(codes).not.toContain("codex_openai_api_key_missing");
    expect(codes).not.toContain("codex_native_auth_present");
    expect(codes).not.toContain("codex_hello_probe_passed");
    // The real Codex process must never be spawned for a Databricks connectivity check.
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      DATABRICKS_BASE_URL,
      expect.objectContaining({ headers: { Authorization: `Bearer ${DATABRICKS_TOKEN}` } }),
    );
  });

  it("fails with databricks_connectivity_invalid_credential on 401", async () => {
    stubFetch(401);
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain(
      "databricks_connectivity_invalid_credential",
    );
  });

  it("fails with databricks_connectivity_insufficient_permission on 403", async () => {
    stubFetch(403);
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain(
      "databricks_connectivity_insufficient_permission",
    );
  });

  it("warns with databricks_connectivity_rate_limited on 429, capturing Retry-After", async () => {
    stubFetch(429, { "retry-after": "42" });
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);
    expect(result.status).toBe("warn");
    const check = result.checks.find((c) => c.code === "databricks_connectivity_rate_limited");
    expect(check).toBeDefined();
    expect(check?.detail).toContain("42");
  });

  it("fails with databricks_connectivity_unavailable on 5xx", async () => {
    stubFetch(503);
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("databricks_connectivity_unavailable");
  });

  it("fails with databricks_connectivity_unavailable on a network/timeout failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("databricks_connectivity_unavailable");
  });

  it("warns with databricks_connectivity_token_missing when DATABRICKS_TOKEN is absent, without calling fetch", async () => {
    const fetchMock = stubFetch(200);
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: "codex",
        cwd: "/tmp/project",
        providerRuntimeHint: {
          provider: "databricks" as const,
          baseUrl: DATABRICKS_BASE_URL,
          wireApi: "responses",
        },
        env: {},
      },
    } as never);
    expect(result.checks.map((check) => check.code)).toContain("databricks_connectivity_token_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks the token into any check's message, detail, or hint", async () => {
    stubFetch(429, { "retry-after": "10" });
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);
    const serialized = JSON.stringify(result.checks);
    expect(serialized).not.toContain(DATABRICKS_TOKEN);
  });
});

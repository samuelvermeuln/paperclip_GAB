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
// The access token the fake OAuth M2M helper mints. The probe now obtains the
// bearer token by running the run's `auth.command` helper (never a static
// `DATABRICKS_TOKEN`), so this is the value that must flow into the Unity
// Gateway connectivity request's Authorization header.
const HELPER_TOKEN = "dapi-helper-minted-token-value";
// A decoy static token planted in `config.env.DATABRICKS_TOKEN`. The probe must
// never read it: the bearer token always comes from the helper's stdout.
const DECOY_DATABRICKS_TOKEN = "dapi-static-decoy-should-never-be-used";
const CREDENTIAL_FILE_PATH = "/tmp/paperclip/run/databricks-credential.json";

/** Node `-e` args for a fake helper that prints `token` to stdout with no
 * trailing newline, exactly like `paperclip-databricks-oauth-token`. */
function printTokenArgs(token: string): string[] {
  return ["-e", `process.stdout.write(${JSON.stringify(token)})`];
}

/** Node `-e` args for a fake helper that fails (non-zero exit, no stdout),
 * mirroring the real helper's behavior when it cannot mint a token. */
function failingHelperArgs(): string[] {
  return ["-e", "process.exit(3)"];
}

function databricksConfig(
  overrides: {
    authCommand?: string;
    authArgs?: string[];
    includeCredentialFile?: boolean;
    extraEnv?: Record<string, string>;
  } = {},
) {
  const includeCredentialFile = overrides.includeCredentialFile ?? true;
  const env: Record<string, string> = { ...overrides.extraEnv };
  if (includeCredentialFile) env.DATABRICKS_CREDENTIAL_FILE = CREDENTIAL_FILE_PATH;
  return {
    command: "codex",
    cwd: "/tmp/project",
    providerRuntimeHint: {
      provider: "databricks" as const,
      baseUrl: DATABRICKS_BASE_URL,
      wireApi: "responses",
      // Use the running Node binary as a cross-platform stand-in for the
      // installed helper binary, so the probe spawns a real short-lived
      // subprocess (real execFile path) rather than a stubbed function.
      authCommand: overrides.authCommand ?? process.execPath,
      authArgs: overrides.authArgs ?? printTokenArgs(HELPER_TOKEN),
      authTimeoutMs: 5_000,
      authRefreshIntervalMs: 1_800_000,
    },
    env,
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
    // The bearer token is the value the helper printed to stdout, proving the
    // probe minted it through `auth.command` rather than any env token.
    expect(fetchMock).toHaveBeenCalledWith(
      DATABRICKS_BASE_URL,
      expect.objectContaining({ headers: { Authorization: `Bearer ${HELPER_TOKEN}` } }),
    );
  });

  it("obtains the bearer token from the helper, never from env.DATABRICKS_TOKEN", async () => {
    const fetchMock = stubFetch(200);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      // Plant a static DATABRICKS_TOKEN in the run env. The probe must ignore
      // it entirely and use only the helper-minted token (Property 8).
      config: databricksConfig({ extraEnv: { DATABRICKS_TOKEN: DECOY_DATABRICKS_TOKEN } }),
    } as never);

    expect(result.status).toBe("pass");
    expect(fetchMock).toHaveBeenCalledWith(
      DATABRICKS_BASE_URL,
      expect.objectContaining({ headers: { Authorization: `Bearer ${HELPER_TOKEN}` } }),
    );
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const authorization = (requestInit.headers as Record<string, string>).Authorization;
    expect(authorization).not.toContain(DECOY_DATABRICKS_TOKEN);
    // The decoy static token must not leak into any surfaced check either.
    expect(JSON.stringify(result.checks)).not.toContain(DECOY_DATABRICKS_TOKEN);
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

  it("warns with databricks_connectivity_token_missing when the credential file is not configured, without calling fetch", async () => {
    const fetchMock = stubFetch(200);
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      // Helper command present, but no DATABRICKS_CREDENTIAL_FILE in the run
      // env: no token can be minted, so the connectivity call is skipped.
      config: databricksConfig({ includeCredentialFile: false }),
    } as never);
    expect(result.checks.map((check) => check.code)).toContain("databricks_connectivity_token_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors with databricks_connectivity_helper_failed when the helper exits non-zero, without calling fetch", async () => {
    const fetchMock = stubFetch(200);
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      // Helper and credential file are both configured, but the helper cannot
      // mint a token (non-zero exit): skip the connectivity call and surface an
      // error-level check. Its stderr is never surfaced (Requirements 4.6/8.x).
      config: databricksConfig({ authArgs: failingHelperArgs() }),
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("databricks_connectivity_helper_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks the helper-minted token into any check's message, detail, or hint", async () => {
    stubFetch(429, { "retry-after": "10" });
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: databricksConfig(),
    } as never);
    const serialized = JSON.stringify(result.checks);
    expect(serialized).not.toContain(HELPER_TOKEN);
  });
});

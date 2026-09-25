import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Controlled failure hook for the "ephemeral dir cannot be created/restricted"
// test. The mock delegates to the real `node:fs/promises` for everything
// (so the embedded-Postgres harness and every other write are untouched) and
// only rejects the Databricks credential-file write while `failDatabricks
// CredentialWrite` is set — simulating an OS-level create/permission failure at
// exactly the step Requirement 5.5 must abort on.
const fsControl = vi.hoisted(() => ({ failDatabricksCredentialWrite: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      if (
        fsControl.failDatabricksCredentialWrite &&
        String(args[0]).includes("databricks-credential.json")
      )
        return Promise.reject(
          Object.assign(
            new Error("EACCES: simulated Databricks credential file failure"),
            { code: "EACCES" },
          ),
        );
      return actual.writeFile(...args);
    },
  };
});
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants, toolConnectionInstalls } from "@paperclipai/db";
import { type AiConnectionBinding } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-hire-ai-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "hire-ai");
  database = await startEmbeddedPostgresTestDatabase("paperclip-hire-ai-db-");
  db = createDb(database.connectionString);
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

async function fixture(provider: "anthropic" | "openai", method: "api_key" | "subscription" = "api_key") {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `owner-${companyId}`;
  const binding = { provider, method, mode: "responsible_user" } as const;
  const adapterType = provider === "anthropic" ? "claude_local" : "codex_local";
  await db.insert(companies).values({ id: companyId, name: "Hiring connection test", issuePrefix: `H${companyId.slice(0, 7)}`, defaultResponsibleUserId: userId });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:create" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Manager", role: "ceo", adapterType, runtimeConfig: { aiConnection: binding } });
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", responsibleUserId: userId }).returning();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "agent", agentId, companyId, runId: run!.id, source: "agent_jwt", onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  const credential = method === "api_key" ? "fixture-api-key" : provider === "anthropic" ? "fixture-subscription-token" : JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } });
  const account = await aiConnectionService(db).save(companyId, userId, {
    provider, method, name: "Manager's connection", ownership: "personal", agentIds: [agentId], allAgents: false,
    ...(method === "api_key" ? { apiKey: credential } : { loginSessionId: "fixture" }),
  }, credential);
  return { app, companyId, agentId, userId, binding, adapterType, account, runId: run!.id };
}

function hired(response: request.Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.agent ?? response.body;
}

describe("agent-created hires use managed AI connections", () => {
  for (const endpoint of ["agent-hires", "agents"]) {
    it.each([
      ["anthropic", "api_key"], ["anthropic", "subscription"],
      ["openai", "api_key"], ["openai", "subscription"],
    ] as const)(`${endpoint}: %s hires its own provider using the same %s binding`, async (provider, method) => {
      const f = await fixture(provider, method);
      const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({ name: "Teammate", role: "engineer", adapterType: f.adapterType, reportsTo: f.agentId }));
      expect(agent.runtimeConfig.aiConnection).toEqual(f.binding);
      const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType: agent.adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig });
      try {
        expect(runtime.attribution).toMatchObject({ connectionId: f.account.connectionId, grantId: f.account.grantId, method, responsibleUserId: f.userId });
      } finally { await runtime.cleanup(); }
    });
  }

  for (const endpoint of ["agent-hires", "agents"]) {
    it.each([
      ["ANTHROPIC_API_KEY", "child-key"],
      ["ANTHROPIC_API_KEY", ""],
      ["CLAUDE_CONFIG_DIR", "/tmp/child-claude-home"],
      ["ANTHROPIC_BASE_URL", "https://example.invalid"],
    ])(`${endpoint}: preserves an explicit child auth setting %s=%s`, async (key, value) => {
      const f = await fixture("anthropic");
      const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({
        name: "Explicit auth", role: "engineer", adapterType: f.adapterType,
        adapterConfig: { env: { [key]: value } },
      }));
      expect(agent.runtimeConfig.aiConnection).toBeUndefined();
      const [saved] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect((saved.adapterConfig.env as Record<string, unknown>)[key]).toEqual({ type: "plain", value });
    });
  }

  it.each([true, false])("managed bindings do not inherit legacy credentials (managed parent: %s)", async (managedParent) => {
    const f = await fixture("openai");
    const secret = await secretService(db).create(f.companyId, {
      name: "Legacy parent key", provider: "local_encrypted", value: "fixture-legacy-key",
    });
    await db.update(agents).set({
      runtimeConfig: managedParent ? { aiConnection: f.binding } : {},
      adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id } } },
    }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({
      name: "Managed child", role: "engineer", adapterType: f.adapterType,
      ...(managedParent ? {} : { runtimeConfig: { aiConnection: f.binding } }),
    }));
    expect(agent.runtimeConfig.aiConnection).toEqual(f.binding);
    expect(agent.adapterConfig.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps unmanaged parent hires on their existing authentication path", async () => {
    const f = await fixture("openai");
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, f.agentId));
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({
      name: "Legacy authentication", role: "engineer", adapterType: f.adapterType,
    }));
    expect(agent.runtimeConfig.aiConnection).toBeUndefined();
  });

  it.each(["anthropic", "openai"] as const)("%s can hire the other provider before that user connects it", async (provider) => {
    const f = await fixture(provider);
    const otherProvider = provider === "anthropic" ? "openai" : "anthropic";
    const adapterType = otherProvider === "anthropic" ? "claude_local" : "codex_local";
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Other provider", role: "engineer", adapterType }));
    expect(agent.runtimeConfig.aiConnection).toMatchObject({ provider: otherProvider, mode: "responsible_user" });
    await expect(prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig })).rejects.toMatchObject({ details: { code: "ai_connection_default_missing" } });
    expect(agent.status).toBe("idle");
  });

  for (const endpoint of ["agent-hires", "agents"]) {
    it.each([
      ["anthropic", "codex_local", {}, "ANTHROPIC_API_KEY"],
      ["openai", "claude_local", {}, "OPENAI_API_KEY"],
      ["anthropic", "paperclip_runner", { provider: "codex" }, "ANTHROPIC_API_KEY"],
      ["openai", "paperclip_runner", { provider: "acpx", acpxAgent: "claude" }, "OPENAI_API_KEY"],
    ] as const)(`${endpoint}: ignores the %s auth key for a different provider in %s`, async (provider, adapterType, config, key) => {
      const f = await fixture(provider);
      const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/${endpoint}`).send({
        name: "Cross-provider config", role: "engineer", adapterType,
        adapterConfig: { ...config, env: { [key]: "leftover-parent-setting" } },
      }));
      expect(agent.runtimeConfig.aiConnection).toMatchObject({
        provider: provider === "anthropic" ? "openai" : "anthropic", mode: "responsible_user",
      });
    });
  }

  it("accepts an explicit personal default before authentication, including approval-gated hires", async () => {
    const f = await fixture("anthropic");
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, f.companyId));
    const binding: AiConnectionBinding = { provider: "openai", method: "subscription", mode: "responsible_user" };
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Future Codex", role: "engineer", adapterType: "codex_local", runtimeConfig: { aiConnection: binding } });
    const agent = hired(response);
    expect(agent.runtimeConfig.aiConnection).toEqual(binding);
    expect(agent.status).toBe("pending_approval");
    expect(response.body.approval.payload.runtimeConfig.aiConnection).toEqual(binding);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).toEqual([]);
  });

  it.each(["anthropic", "openai"] as const)("inherits %s when the hire uses the native runner", async (provider) => {
    const f = await fixture(provider, "subscription");
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Native teammate", role: "engineer", adapterType: "paperclip_runner", adapterConfig: provider === "anthropic" ? { provider: "acpx", acpxAgent: "claude" } : { provider: "codex" } }));
    expect(agent.runtimeConfig.aiConnection).toEqual(f.binding);
    const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType: agent.adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig });
    try { expect(runtime.attribution.connectionId).toBe(f.account.connectionId); } finally { await runtime.cleanup(); }
  });

  it.each([true, false])("preserves shared connection access boundaries (company access: %s)", async (allAgents) => {
    const f = await fixture("anthropic");
    const account = await aiConnectionService(db).save(f.companyId, f.userId, { provider: "anthropic", method: "api_key", name: "Shared Claude", ownership: "shared", apiKey: "fixture", agentIds: [f.agentId], allAgents }, "fixture");
    const binding = { provider: "anthropic", method: "api_key", mode: "shared", ...account };
    await db.update(agents).set({ runtimeConfig: { aiConnection: binding } }).where(eq(agents.id, f.agentId));
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Shared teammate", role: "engineer", adapterType: f.adapterType });
    if (!allAgents) {
      expect(response.status).toBe(403);
      expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
    } else {
      const agent = hired(response);
      expect(agent.runtimeConfig.aiConnection).toEqual(binding);
      const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: agent.id, responsibleUserId: f.userId, adapterType: agent.adapterType, binding: agent.runtimeConfig.aiConnection, config: agent.adapterConfig });
      try { expect(runtime.attribution.connectionId).toBe(account.connectionId); } finally { await runtime.cleanup(); }
    }
  });

  it("still rejects an explicitly incompatible provider without creating a hire", async () => {
    const f = await fixture("anthropic");
    const response = await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Wrong provider", role: "engineer", adapterType: "codex_local", runtimeConfig: { aiConnection: f.binding } });
    expect(response.status).toBe(422);
    expect(response.body.details.code).toBe("ai_connection_incompatible");
    expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
  });
});

describe("hired agents sharing a subscription", () => {
  it.each(["openai", "anthropic"] as const)("runs the %s child alongside a live parent and inherits its connection", async (provider) => {
    const f = await fixture(provider, "subscription");
    const agent = hired(await request(f.app).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Concurrent teammate", role: "engineer", adapterType: f.adapterType, reportsTo: f.agentId, adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { heartbeat: { enabled: false } } }));
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Subscription child task", status: "todo", assigneeAgentId: agent.id, responsibleUserId: f.userId, createdByUserId: f.userId }).returning();
    const parentRuntime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: f.agentId, responsibleUserId: f.userId, adapterType: f.adapterType, binding: f.binding, config: { cwd: home } });
    const execute = vi.fn(async () => {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue.id));
      return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
    });
    registerServerAdapter({ ...getServerAdapter(f.adapterType), execute });
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(agent.id, "assignment", { issueId: issue.id, wakeReason: "issue_assigned", responsibleUserId: f.userId }, "system");
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
      const finished = await heartbeat.getRun(run!.id);
      expect(finished?.errorCode).not.toBe("ai_connection_busy");
      expect(finished?.contextSnapshot?.aiConnection).toMatchObject({ connectionId: f.account.connectionId, responsibleUserId: f.userId, method: "subscription" });
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_busy")))).toEqual([]);
    } finally {
      await parentRuntime.cleanup();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(f.adapterType);
    }
  });
});

// --- Task 7.2: Databricks OAuth M2M ephemeral credential file at runtime ---
//
// These tests exercise the runtime behavior added by task 7.1 in
// `prepareManagedAiRuntime`: for a Databricks (`oauth_m2m`) binding it writes a
// 0600 `databricks-credential.json` into the run's ephemeral provider home,
// exposes only its path via `DATABRICKS_CREDENTIAL_FILE`, builds a secret-free
// `providerRuntimeHint`, aborts preparation if the file cannot be
// created/restricted, and removes the whole home (and thus the file) on
// `cleanup()`.
//
// Validates Property 2 (multi-tenant isolation) and Property 3 (no secret on
// observable surfaces) — Requirements 4.8, 4.9, 5.4, 5.5, 5.6.

/** Absolute path of the run's Databricks credential file inside a managed home,
 * mirroring `databricksCredentialFilePath` in ai-connection-runtime.ts. */
function databricksCredentialFile(runtimeHome: string): string {
  return path.join(runtimeHome, "provider", "databricks-credential.json");
}

async function databricksFixture(options?: {
  clientSecret?: string;
  workspaceHost?: string;
  catalog?: string;
  schema?: string;
}) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `owner-${companyId}`;
  const clientId = "dbx-client-id";
  const clientSecret = options?.clientSecret ?? `dbx-secret-${randomUUID()}`;
  const workspaceHost = options?.workspaceHost ?? "https://acme.cloud.databricks.com";
  const catalog = options?.catalog ?? "main";
  const schema = options?.schema ?? "paperclip";
  const binding = { provider: "databricks", method: "oauth_m2m", mode: "responsible_user" } as const;
  await db.insert(companies).values({ id: companyId, name: "Databricks runtime test", issuePrefix: `D${companyId.slice(0, 7)}`, defaultResponsibleUserId: userId });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Manager", role: "ceo", adapterType: "codex_local", runtimeConfig: { aiConnection: binding } });
  const account = await aiConnectionService(db).save(
    companyId,
    userId,
    { provider: "databricks", method: "oauth_m2m", name: "Databricks connection", ownership: "personal", agentIds: [], allAgents: true, clientId, clientSecret, workspaceHost, catalog, schema },
    "unused-for-databricks",
  );
  return { companyId, agentId, userId, binding, account, clientId, clientSecret, workspaceHost, catalog, schema };
}

function prepareDatabricksRuntime(f: Awaited<ReturnType<typeof databricksFixture>>) {
  return prepareManagedAiRuntime(db, {
    companyId: f.companyId,
    agentId: f.agentId,
    responsibleUserId: f.userId,
    adapterType: "codex_local",
    binding: f.binding,
    config: {},
  });
}

describe("Databricks OAuth M2M runtime credential file", () => {
  it("writes a 0600 credential file the OAuth helper reads by path and removes it on cleanup (successful run)", async () => {
    const f = await databricksFixture();
    const runtime = await prepareDatabricksRuntime(f);
    const credentialFile = databricksCredentialFile(runtime.home);
    try {
      // The file exists and its path — never the secret itself — is what the
      // runtime exposes to the Codex process for the helper to read.
      await expect(access(credentialFile)).resolves.toBeUndefined();
      expect((runtime.config.env as Record<string, unknown>).DATABRICKS_CREDENTIAL_FILE).toBe(credentialFile);
      expect(JSON.parse(await readFile(credentialFile, "utf8"))).toEqual({
        host: f.workspaceHost,
        clientId: f.clientId,
        clientSecret: f.clientSecret,
      });
      // POSIX 0600 is asserted only where the platform honors file modes; on
      // Windows the bits do not map to POSIX permissions, so we assert only
      // that the file was created (checked above) and later removed.
      if (process.platform !== "win32")
        expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
      // The routing hint carries only non-secret execution wiring.
      expect(runtime.config.providerRuntimeHint).toEqual({
        provider: "databricks",
        baseUrl: `${f.workspaceHost}/ai-gateway/codex/v1`,
        wireApi: "responses",
        authCommand: expect.any(String),
        authArgs: [],
        authTimeoutMs: 5_000,
        authRefreshIntervalMs: 1_800_000,
      });
    } finally {
      await runtime.cleanup();
    }
    // cleanup() removes the whole ephemeral home, and thus the credential file.
    await expect(access(credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(runtime.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the credential file on cleanup even when the run fails", async () => {
    const f = await databricksFixture();
    const runtime = await prepareDatabricksRuntime(f);
    const credentialFile = databricksCredentialFile(runtime.home);
    await expect(access(credentialFile)).resolves.toBeUndefined();
    // Simulate a run that throws mid-execution: cleanup() still runs in the
    // caller's finally and must leave nothing behind (Requirement 5.6).
    try {
      throw new Error("simulated execution failure");
    } catch {
      /* the run failed; the caller always cleans up regardless of outcome */
    } finally {
      await runtime.cleanup();
    }
    await expect(access(credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(runtime.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives each concurrent run of the same organization its own ephemeral home and credential file", async () => {
    const f = await databricksFixture({ clientSecret: "same-org-shared-secret" });
    const [a, b] = await Promise.all([prepareDatabricksRuntime(f), prepareDatabricksRuntime(f)]);
    try {
      // Two runs of the same connection never share or reuse a home directory.
      expect(a.home).not.toBe(b.home);
      const fileA = databricksCredentialFile(a.home);
      const fileB = databricksCredentialFile(b.home);
      expect(fileA).not.toBe(fileB);
      // Neither run's credential file lives inside the other's home tree, so
      // one run's process cannot locate the other's file by walking its home.
      expect(fileA.startsWith(b.home + path.sep)).toBe(false);
      expect(fileB.startsWith(a.home + path.sep)).toBe(false);
      await expect(access(fileA)).resolves.toBeUndefined();
      await expect(access(fileB)).resolves.toBeUndefined();
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });

  it("isolates concurrent runs of different organizations: neither can read the other's credential file (Property 2)", async () => {
    const secretA = "org-a-client-secret";
    const secretB = "org-b-client-secret";
    const [fa, fb] = await Promise.all([
      databricksFixture({ clientSecret: secretA }),
      databricksFixture({ clientSecret: secretB }),
    ]);
    const [a, b] = await Promise.all([prepareDatabricksRuntime(fa), prepareDatabricksRuntime(fb)]);
    const fileA = databricksCredentialFile(a.home);
    const fileB = databricksCredentialFile(b.home);
    try {
      expect(a.home).not.toBe(b.home);
      expect(fileA).not.toBe(fileB);
      // Each file lives only under its own run's home, never the other's.
      expect(fileA.startsWith(b.home + path.sep)).toBe(false);
      expect(fileB.startsWith(a.home + path.sep)).toBe(false);
      // Org A's file holds only org A's secret and org B's only org B's — one
      // organization's run cannot read the other's client secret.
      const contentA = JSON.parse(await readFile(fileA, "utf8"));
      const contentB = JSON.parse(await readFile(fileB, "utf8"));
      expect(contentA.clientSecret).toBe(secretA);
      expect(contentB.clientSecret).toBe(secretB);
      expect(await readFile(fileA, "utf8")).not.toContain(secretB);
      expect(await readFile(fileB, "utf8")).not.toContain(secretA);
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
    // Both ephemeral homes are gone after cleanup.
    await expect(access(fileA)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(fileB)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts preparation without a usable config when the ephemeral credential file cannot be written (Requirement 5.5)", async () => {
    const f = await databricksFixture();
    fsControl.failDatabricksCredentialWrite = true;
    try {
      // The credential-file write fails, so preparation rejects and never
      // returns a config — the Codex process is never started for this run.
      await expect(prepareDatabricksRuntime(f)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      fsControl.failDatabricksCredentialWrite = false;
    }
    // A subsequent run with the write restored succeeds, proving the failure
    // was isolated to the aborted attempt and left no poisoned state.
    const runtime = await prepareDatabricksRuntime(f);
    try {
      await expect(access(databricksCredentialFile(runtime.home))).resolves.toBeUndefined();
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps the client secret out of the returned config, the routing hint, and process logs (Property 3)", async () => {
    const secret = `only-in-the-file-${randomUUID()}`;
    const f = await databricksFixture({ clientSecret: secret });
    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    let captured = "";
    // Restore console and snapshot everything it saw whether prepare resolves
    // or rejects, so a failure still prints and `runtime` stays definitely
    // assigned for the assertions below.
    const runtime = await prepareDatabricksRuntime(f).finally(() => {
      captured = logSpies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
        .join("\n");
      for (const spy of logSpies) spy.mockRestore();
    });
    try {
      // The secret exists only inside the credential file — never in the config
      // handed to the adapter, the provider routing hint, or any log output.
      expect(JSON.stringify(runtime.config)).not.toContain(secret);
      expect(JSON.stringify(runtime.config.providerRuntimeHint)).not.toContain(secret);
      expect(JSON.stringify(runtime.config.env)).not.toContain(secret);
      expect(captured).not.toContain(secret);
      // Sanity check: the secret really is written to the credential file, so
      // the assertions above are proving containment rather than absence.
      expect(await readFile(databricksCredentialFile(runtime.home), "utf8")).toContain(secret);
    } finally {
      await runtime.cleanup();
    }
  });
});

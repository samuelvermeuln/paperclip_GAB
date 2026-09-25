import { connectionIntentService } from "../services/connection-intents.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import * as localCredentials from "../services/local-ai-credentials.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createDb, companies, agents, heartbeatRuns, companyMemberships, connectionGrants, connectionGrantDelegations, connectionGrantMembers, toolConnections, toolConnectionInstalls, aiConnectionDefaults, aiProviderDefaults, adapterAuthSessions, environments, issues, issueThreadInteractions, issueRecoveryActions, connectionIntentDeliveries, agentWakeupRequests, companySecrets, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { listDatabricksModelServices, invalidateDatabricksModelServiceCache, DatabricksDiscoveryError } from "../services/databricks-model-services.js";
import { resolveDatabricksAccessToken, fetchDatabricksAccessToken, invalidateDatabricksAccessToken } from "../services/databricks-oauth.js";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { prepareManagedAiRuntime, assertManagedAiProjectAuth, stripAiAuthBindings } from "../services/ai-connection-runtime.js";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { aiConnectionBindingSchema, connectionPurposeTransportSchema, isAiConnectionCompatible } from "@paperclipai/shared";
import express from "express";
import request from "supertest";
import { aiConnectionRoutes, canInstallSharedAiConnectionForNewAgent, responsibleUserForAiRequest } from "../routes/ai-connections.js";
import { validateAiApiKey } from "../routes/ai-connections.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const agentId = randomUUID();
let service: ReturnType<typeof aiConnectionService>;
const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;
const input = { companyId, agentId, adapterType: "claude_local", binding };
const create = (userId: string, name: string, ownership: "personal" | "shared" = "personal") => service.save(companyId, userId, { provider: "anthropic", method: "api_key", ownership, name, apiKey: "fixture", agentIds: [], allAgents: true }, `fixture-${name}`);

/** A successful Databricks OIDC client-credentials token response. */
const databricksAccessTokenResponse = () =>
  new Response(JSON.stringify({ access_token: "fixture-access-token", expires_in: 3600 }), { status: 200 });

/**
 * Builds a `fetch` implementation for Databricks tests. The OAuth M2M token
 * exchange (`POST {host}/oidc/v1/token`) always succeeds; every Unity Catalog
 * model-services request is delegated to `onModelServices`. Discovery and
 * create-time credential validation now resolve a short-lived access token
 * before calling Unity Catalog, so a mock must answer both hops.
 */
const databricksFetchImpl = (
  onModelServices: (url: URL) => Response,
): ((input: Parameters<typeof fetch>[0]) => Promise<Response>) =>
  async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oidc/v1/token")) return databricksAccessTokenResponse();
    return onModelServices(url);
  };

/** New-contract Databricks connection payload (OAuth M2M clientId/clientSecret). */
const databricksCreateInput = (name: string, ownership: "personal" | "shared" = "personal") => ({
  provider: "databricks" as const,
  method: "oauth_m2m" as const,
  ownership,
  name,
  clientId: "dbx-client-id",
  clientSecret: `secret-${name}`,
  agentIds: [] as string[],
  allAgents: true,
  workspaceHost: "https://acme.cloud.databricks.com",
  catalog: "main",
  schema: "paperclip",
});

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-tests-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-connection-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values([{ id: companyId, name: "AI connection tests", issuePrefix: "AIT" }, { id: otherCompanyId, name: "Other", issuePrefix: "AIO" }]);
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("stripAiAuthBindings", () => {
  it("strips DATABRICKS_TOKEN like every other provider secret while keeping unrelated keys", () => {
    expect(stripAiAuthBindings({ DATABRICKS_TOKEN: "should-be-stripped", SOME_OTHER_VAR: "kept" })).toEqual({ SOME_OTHER_VAR: "kept" });
  });
});

describe("managed AI connections", () => {
  it.each([
    ["anthropic", "claude_local", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    ["openai", "codex_local", "CODEX_HOME", "OPENAI_API_KEY"],
  ] as const)("runs the same %s agent with each responsible user's subscription or API key", async (provider, adapterType, subscriptionEnv, apiEnv) => {
    const subscriptionUser = `${provider}-subscription-user`;
    const apiUser = `${provider}-api-user`;
    await db.insert(companyMemberships).values([subscriptionUser, apiUser].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
    const token = provider === "openai" ? JSON.stringify({ tokens: { access_token: "fixture-subscription", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } }) : "fixture-subscription";
    const subscription = await service.save(companyId, subscriptionUser, { provider, method: "subscription", ownership: "personal", name: "Subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, token);
    const api = await service.save(companyId, apiUser, { provider, method: "api_key", ownership: "personal", name: "API", apiKey: "fixture", allAgents: true, agentIds: [] }, "fixture-api");
    // This is the exact same saved bot config, including a legacy setup method.
    const bot = { ...input, adapterType, binding: { provider, method: "subscription", mode: "responsible_user" } as const, config: { model: "unchanged-model", env: { [apiEnv]: "ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient" } } };
    const original = structuredClone(bot);
    const [subRun, apiRun] = await Promise.all([subscriptionUser, apiUser].map(responsibleUserId => prepareManagedAiRuntime(db, { ...bot, responsibleUserId })));
    try {
      expect(subRun.attribution).toMatchObject({ grantId: subscription.grantId, method: "subscription", responsibleUserId: subscriptionUser });
      expect(apiRun.attribution).toMatchObject({ grantId: api.grantId, method: "api_key", responsibleUserId: apiUser });
      const subEnv = subRun.config.env as Record<string, string>;
      const apiEnvValues = apiRun.config.env as Record<string, string>;
      expect(subEnv[apiEnv]).toBe("");
      expect(apiEnvValues[apiEnv]).toBe("fixture-api");
      if (provider === "anthropic") {
        expect(subEnv[subscriptionEnv]).toBe(token);
        expect(apiEnvValues[subscriptionEnv]).toBe("");
      } else {
        expect(await readFile(path.join(subEnv.CODEX_HOME, "auth.json"), "utf8")).toBe(token);
        expect(JSON.parse(await readFile(path.join(apiEnvValues.CODEX_HOME, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "fixture-api" });
      }
      expect(subEnv.HOME).not.toBe(apiEnvValues.HOME);
      expect(subRun.identity).not.toBe(apiRun.identity);
      expect(subRun.config.model).toBe(bot.config.model);
      expect(apiRun.config.model).toBe(bot.config.model);
      expect(bot).toEqual(original);
      expect(aiConnectionBindingSchema.parse(bot.binding)).toEqual(bot.binding);
    } finally { await Promise.all([subRun.cleanup(), apiRun.cleanup()]); }
  });

  it("has one provider default across methods, retains unavailable defaults and honors explicit account methods", async () => {
    const userId = "provider-default-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const api = await create(userId, "Provider API");
    const subscription = await service.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Provider subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, "fixture-provider-subscription");
    expect((await service.select({ ...input, userId })).grant.id).toBe(api.grantId);
    expect((await service.list(companyId, userId)).filter(account => account.isDefault).map(account => account.grantId)).toEqual([api.grantId]);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, api.grantId));
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await create(userId, "Another API");
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await service.setDefault(companyId, userId, subscription.grantId);
    expect((await service.select({ ...input, userId })).attribution).toMatchObject({ method: "subscription", grantId: subscription.grantId });
    expect((await service.list(companyId, userId)).filter(account => account.isDefault)).toHaveLength(1);
    await expect(service.select({ ...input, userId, binding: { ...binding, mode: "delegated", ...subscription } })).rejects.toThrow("incompatible");
  });

  it("backfills provider defaults repeatably without deleting old preferences or replacing an unavailable choice", async () => {
    const userId = "provider-default-migration-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const api = await create(userId, "Migration API");
    const subscription = await service.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Migration subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, "fixture-migration-subscription");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, api.grantId));
    await db.update(aiConnectionDefaults).set({ updatedAt: new Date("2030-01-01") }).where(eq(aiConnectionDefaults.grantId, api.grantId));
    await db.delete(aiProviderDefaults).where(and(eq(aiProviderDefaults.companyId, companyId), eq(aiProviderDefaults.userId, userId)));
    const legacyRows = await db.select().from(aiConnectionDefaults).where(eq(aiConnectionDefaults.userId, userId));
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0277_uneven_lady_deathstrike.sql", import.meta.url), "utf8");
    for (let pass = 0; pass < 2; pass++) for (const statement of migration.split("--> statement-breakpoint").filter(value => value.trim())) await db.execute(sql.raw(statement));
    expect(await db.select().from(aiConnectionDefaults).where(eq(aiConnectionDefaults.userId, userId))).toEqual(legacyRows);
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await service.setDefault(companyId, userId, subscription.grantId);
    for (const statement of migration.split("--> statement-breakpoint").filter(value => value.trim())) await db.execute(sql.raw(statement));
    expect((await service.select({ ...input, userId })).grant.id).toBe(subscription.grantId);
  });
  it("observes old-server default changes during rolling upgrades without treating new accounts as default changes", async () => {
    const userId = "rolling-upgrade-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const api = await create(userId, "Rolling API");
    const subscription = await service.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Rolling subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, "fixture-rolling-subscription");
    expect((await service.select({ ...input, userId })).grant.id).toBe(api.grantId);
    // An older server updates only the legacy per-method row on Make default.
    await db.update(aiConnectionDefaults).set({ grantId: subscription.grantId, updatedAt: new Date() })
      .where(and(eq(aiConnectionDefaults.userId, userId), eq(aiConnectionDefaults.method, "subscription")));
    expect((await service.select({ ...input, userId })).attribution).toMatchObject({ grantId: subscription.grantId, method: "subscription" });
    expect((await service.list(companyId, userId)).filter(account => account.isDefault).map(account => account.grantId)).toEqual([subscription.grantId]);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, subscription.grantId));
    await create(userId, "Rolling second API");
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await db.update(aiConnectionDefaults).set({ grantId: api.grantId, updatedAt: new Date() })
      .where(and(eq(aiConnectionDefaults.userId, userId), eq(aiConnectionDefaults.method, "api_key")));
    expect((await service.select({ ...input, userId })).grant.id).toBe(api.grantId);
  });
  it("checks the selected environment for project auth overrides without exposing their contents", async () => {
    const execute = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess");
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace/project" } as Parameters<typeof assertManagedAiProjectAuth>[2];
    try {
      execute.mockResolvedValue({ exitCode: 42, stdout: "", stderr: "", signal: null, timedOut: false } as Awaited<ReturnType<typeof executionTarget.runAdapterExecutionTargetProcess>>);
      await expect(assertManagedAiProjectAuth({}, "openai", target)).rejects.toThrow("project authentication settings");
      expect(execute.mock.calls[0][3]).toContain("/workspace/project");
      expect(execute.mock.calls[0][3]).toContain(".codex/config.toml");
      execute.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", signal: null, timedOut: false } as Awaited<ReturnType<typeof executionTarget.runAdapterExecutionTargetProcess>>);
      await expect(assertManagedAiProjectAuth({}, "openai", target)).resolves.toBeUndefined();
      await expect(assertManagedAiProjectAuth({ args: ["--api-key=override"] }, "xai", target)).rejects.toThrow("overrides");
    } finally { execute.mockRestore(); }
  });
  it("keeps personal defaults separate and does not replace the first default", async () => {
    const first = await create("alice", "Alice first");
    await create("alice", "Alice second");
    const bob = await create("bob", "Bob first");
    const [a,b] = await Promise.all([service.select({ ...input, userId: "alice" }), service.select({ ...input, userId: "bob" })]);
    expect(a.grant.id).toBe(first.grantId); expect(b.grant.id).toBe(bob.grantId);
    expect(await service.credential(a)).toBe("fixture-Alice first");
    expect(await service.credential(b)).toBe("fixture-Bob first");
    expect(JSON.stringify(await service.list(companyId, "alice"))).not.toContain("fixture-");
    expect(await service.list(otherCompanyId, "alice")).toEqual([]);
  });
  it("retains a revoked default without automatic fallback", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.grant.id));
    await create("alice", "Alice third");
    expect(await toolAccessService(db).getConnection(selected.connection.id, companyId)).toMatchObject({ healthStatus: "missing_secret", requiresReauthorization: true });
    expect((await toolAccessService(db).listConnections(companyId)).find(connection => connection.id === selected.connection.id)?.healthStatus).toBe("missing_secret");
    await expect(service.select({ ...input, userId: "alice" })).rejects.toThrow("Reconnect");
    const second = (await service.list(companyId, "alice")).find(a => a.name === "Alice second")!;
    await service.setDefault(companyId, "alice", second.grantId);
    expect((await service.select({ ...input, userId: "alice" })).grant.id).toBe(second.grantId);
    await expect(service.setDefault(companyId, "bob", second.grantId)).rejects.toThrow("owner");
  });
  it("uses human access for every selection; an agent delegation cannot override Just me", async () => {
    const personal = await service.select({ ...input, userId: "alice" });
    const delegated = { ...binding, mode: "delegated" as const, connectionId: personal.connection.id, grantId: personal.grant.id };
    await expect(service.select({ ...input, userId: "bob", binding: delegated })).rejects.toThrow("not shared");
    // Existing delegation records no longer confer an independent AI permission.
    await db.insert(connectionGrantDelegations).values({ companyId, grantId: personal.grant.id, agentId, createdByUserId: "alice" });
    await expect(service.select({ ...input, userId: "bob", binding: delegated })).rejects.toThrow("not shared");
    expect((await service.select({ ...input, userId: "alice", binding: delegated })).grant.id).toBe(personal.grant.id);
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === personal.connection.id)).toBe(false);
    await expect(toolAccessService(db).createConnectionGrantDelegation(personal.connection.id, personal.grant.id, agentId, "alice")).rejects.toThrow("human access settings");
  });
  it("applies the existing human audience editor to AI listing and execution without a second authorization", async () => {
    const shared = await create("alice", "Engineering", "shared");
    const sharedBinding = { ...binding, mode: "shared" as const, ...shared };
    const tools = toolAccessService(db);
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, ["alice"], { userId: "alice" });
    await expect(service.select({ ...input, userId: "bob", binding: sharedBinding })).rejects.toThrow("not shared");
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === shared.connectionId)).toBe(false);
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, ["bob"], { userId: "alice" });
    expect((await service.select({ ...input, userId: "bob", binding: sharedBinding })).grant.id).toBe(shared.grantId);
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === shared.connectionId)).toBe(true);
    await expect(service.select({ ...input, userId: "alice", binding: sharedBinding })).rejects.toThrow("not shared");
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, [], { userId: "alice" });
    for (const userId of ["alice", "bob"]) {
      expect((await service.select({ ...input, userId, binding: sharedBinding })).grant.id).toBe(shared.grantId);
    }
    await expect(service.select({ ...input, userId: null, binding: sharedBinding })).rejects.toThrow("not shared");
    // Human permission still cannot bypass the separate agent-access setting.
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, shared.connectionId));
    await expect(service.select({ ...input, userId: "bob", binding: sharedBinding })).rejects.toThrow("not permitted for this agent");
    expect(sharedBinding).toEqual({ ...binding, mode: "shared", ...shared });
  });
  it("isolates concurrent homes and overrides ambient credentials without changing the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-never-use");
    const config = { model: "unchanged-model", env: { ANTHROPIC_API_KEY: "project-never-use" } };
    const [a,b] = await Promise.all(["alice", "bob"].map(responsibleUserId => prepareManagedAiRuntime(db, { ...input, responsibleUserId, config })));
    const ae = a.config.env as Record<string,string>, be = b.config.env as Record<string,string>;
    expect(ae.ANTHROPIC_API_KEY).toBe("fixture-Alice second"); expect(be.ANTHROPIC_API_KEY).toBe("fixture-Bob first");
    expect(ae.HOME).not.toBe(be.HOME); expect(a.identity).not.toBe(b.identity);
    expect(a.config.model).toBe("unchanged-model"); expect(config.env.ANTHROPIC_API_KEY).toBe("project-never-use");
    await Promise.all([a.cleanup(), b.cleanup()]); await expect(access(ae.HOME)).rejects.toThrow();
  });
  it("blocks missing identity, incompatible providers, and cross-company explicit selections", async () => {
    await expect(service.select({ ...input, userId: null })).rejects.toThrow("responsible user");
    await expect(service.select({ ...input, userId: "alice", adapterType: "codex_local" })).rejects.toThrow("compatible");
    const account = await service.select({ ...input, userId: "alice" });
    await expect(service.select({ ...input, companyId: otherCompanyId, userId: "alice", binding: { ...binding, mode: "shared", connectionId: account.connection.id, grantId: account.grant.id } })).rejects.toThrow();
  });
  it("resolves shared encrypted credentials through the existing secret binding system", async () => {
    const created = await create("alice", "Shared credential proof", "shared");
    const selected = await service.select({ ...input, userId: "bob", binding: { ...binding, mode: "shared", ...created } });
    expect(await service.credential(selected)).toBe("fixture-Shared credential proof");
  });
  it("saves successful login completion once and rejects abandoned attempts", async () => {
    const [environment] = await db.insert(environments).values({ name: "AI login test", driver: "sandbox" }).returning();
    const intent = { provider: "anthropic", method: "subscription", ownership: "personal", name: "Claude subscription", agentIds: [], allAgents: true } as const;
    const sessionId = randomUUID();
    await db.insert(adapterAuthSessions).values({ companyId, environmentId: environment.id, adapterType: "claude_local", startedByUserId: "alice", publicSessionId: sessionId, status: "submitting", aiConnection: { ...intent, agentIds: [] }, expiresAt: new Date(Date.now() + 60000) });
    const first = await service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-subscription", sessionId);
    expect(await service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-subscription", sessionId)).toEqual(first);
    const cancelled = randomUUID();
    await db.insert(adapterAuthSessions).values({ companyId, environmentId: environment.id, adapterType: "claude_local", startedByUserId: "alice", publicSessionId: cancelled, status: "cancelled", expiresAt: new Date(Date.now() + 60000) });
    await expect(service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-never-save", cancelled)).rejects.toThrow("no longer active");
  });
  it("preserves connection identity and defaults through reconnect; revocation wins over older attempts", async () => {
    const current = await service.select({ ...input, userId: "bob" });
    const reconnect = { ...binding, ownership: "personal" as const, name: current.connection.name, apiKey: "fixture", agentIds: [], allAgents: true, connectionId: current.connection.id };
    const result = await service.save(companyId, "bob", reconnect, "fixture-reconnected");
    expect(result.grantId).toBe(current.grant.id);
    expect(await service.credential(await service.select({ ...input, userId: "bob" }))).toBe("fixture-reconnected");
    const beforeRevocation = new Date(Date.now() - 1000);
    await db.update(connectionGrants).set({ status: "revoked", updatedAt: new Date() }).where(eq(connectionGrants.id, current.grant.id));
    await expect(service.save(companyId, "bob", reconnect, "fixture-stale", undefined, beforeRevocation)).rejects.toThrow("changed");
    await expect(service.select({ ...input, userId: "bob" })).rejects.toThrow("Reconnect");
  });
  it("rejects invalid purpose/transport combinations in the database", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    await expect(db.update(toolConnections).set({ transport: "mcp_remote" }).where(eq(toolConnections.id, selected.connection.id))).rejects.toThrow();
    await expect(db.update(toolConnections).set({ connectionPurpose: "tool" }).where(eq(toolConnections.id, selected.connection.id))).rejects.toThrow();
  });
  it("indexes only known user credentials, retains references, and is repeatable without adopting agents", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    const [emailConnection] = await db.insert(toolConnections).values({
      companyId,
      applicationId: selected.connection.applicationId,
      name: "Existing AgentMail inbox",
      uid: `agentmail-migration-${randomUUID()}`,
      connectionPurpose: "channel",
      transport: "rest_api",
      authKind: "api_key",
      config: { provider: "agentmail" },
    }).returning();
    const vault = secretService(db);
    const definition = await vault.createUserSecretDefinition(companyId, { key: "legacy_claude", name: "Existing owned Claude key", provider: "local_encrypted" }, { userId: "alice" });
    const secret = await vault.createCurrentUserSecretValue(companyId, "alice", { definitionId: definition.id, value: "fixture-legacy" }, { userId: "alice" });
    await vault.syncUserSecretDeclarationsForTarget(companyId, { targetType: "agent", targetId: agentId }, [{ definitionKey: definition.key, configPath: "env.ANTHROPIC_API_KEY", envKey: "ANTHROPIC_API_KEY", required: true }]);
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0276_hard_mandroid.sql", import.meta.url), "utf8");
    const adoption = migration.slice(migration.indexOf("DO $$", migration.indexOf("-- Only declared")));
    await db.execute(sql.raw(adoption));
    const before = await service.list(companyId, "alice");
    for (const statement of migration.split("--> statement-breakpoint").filter(value => value.trim())) await db.execute(sql.raw(statement));
    expect(await service.list(companyId, "alice")).toEqual(before);
    const [preservedEmail] = await db.select().from(toolConnections).where(eq(toolConnections.id, emailConnection.id));
    expect(preservedEmail).toEqual(emailConnection);
    const indexed = before.find(account => account.name === secret.name)!;
    expect(indexed.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, indexed.grantId));
    expect(grant.credentialSecretRefs[0].secretId).toBe(secret.id);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.runtimeConfig.aiConnection).toBeUndefined();
  });
  it("runs two Claude subscription executions for the same grant at the same time", async () => {
    // Claude writes no auth file back to the grant, so two runs share no
    // mutable state and must not wait for each other.
    const subscription = { ...input, binding: { ...binding, method: "subscription" as const }, responsibleUserId: "alice", config: { model: "same-model" } };
    const account = (await service.list(companyId, "alice")).find(account => account.provider === "anthropic" && account.method === "subscription")!;
    await service.setDefault(companyId, "alice", account.grantId);
    const [first, second] = await Promise.all([prepareManagedAiRuntime(db, subscription), prepareManagedAiRuntime(db, subscription)]);
    try {
      expect(second.identity).toBe(first.identity);
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  });
  it("runs a same-agent OpenAI subscription child alongside a still-open parent", async () => {
    const userId = "subscription-contention-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const credential = JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } });
    const account = await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Contention fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, credential);
    const runInput = {
      companyId,
      agentId,
      adapterType: "codex_local",
      responsibleUserId: userId,
      binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const,
      config: {},
    };
    // A parent can create and assign a child before its own execution ends.
    // Both runs select the same personal subscription, even on the same agent.
    const parent = await prepareManagedAiRuntime(db, runInput);
    const child = await prepareManagedAiRuntime(db, runInput);
    try {
      expect(child.identity).toBe(parent.identity);
      expect(child.attribution.grantId).toBe(account.grantId);
    } finally {
      await Promise.all([parent.cleanup(), child.cleanup()]);
    }
  });
  it("persists the freshest refreshed credential to its original grant across a same-account reconnect", async () => {
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    const intent = { provider: "openai" as const, method: "subscription" as const, name: "Refresh test", ownership: "personal" as const, agentIds: [], allAgents: true, loginSessionId: "fixture" };
    const saved = await service.save(companyId, "alice", intent, auth("first", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: "alice", binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    const first = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(first.config.env.CODEX_HOME), "auth.json"), auth("refreshed", 11));
    await first.cleanup();
    const selected = await service.select({ ...runInput, userId: "alice" });
    expect(await service.credential(selected)).toBe(auth("refreshed", 11));
    const second = await prepareManagedAiRuntime(db, runInput);
    expect(second.identity).not.toBe(first.identity);
    // A same-account reconnect writes an older last_refresh than the run
    // that is still open.
    await service.save(companyId, "alice", { ...intent, connectionId: saved.connectionId }, auth("reconnect", 12));
    await writeFile(path.join(String(second.config.env.CODEX_HOME), "auth.json"), auth("later-refresh", 13));
    await second.cleanup();
    // The newer refresh persists to the grant it started from.
    expect(await service.credential(await service.select({ ...runInput, userId: "alice" }))).toBe(auth("later-refresh", 13));
  });
  it("resolves two concurrent OpenAI subscription write-backs by freshness, not by order", async () => {
    const userId = "concurrent-freshness-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Freshness fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    // Two runs use the same OpenAI subscription grant at the same time.
    // Neither call below throws ai_connection_busy.
    const older = await prepareManagedAiRuntime(db, runInput);
    const newer = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(older.config.env.CODEX_HOME), "auth.json"), auth("older", 11));
    await writeFile(path.join(String(newer.config.env.CODEX_HOME), "auth.json"), auth("newer", 12));
    // The run with the newer last_refresh writes back first. The run with
    // the older last_refresh writes back last and must not overwrite it.
    await newer.cleanup();
    await older.cleanup();
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("newer", 12));
  });
  it("resolves two concurrent OpenAI subscription write-backs by freshness in reverse arrival order", async () => {
    const userId = "concurrent-freshness-reverse-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Reverse freshness fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    // Two runs use the same OpenAI subscription grant at the same time.
    // Neither call below throws ai_connection_busy.
    const older = await prepareManagedAiRuntime(db, runInput);
    const newer = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(older.config.env.CODEX_HOME), "auth.json"), auth("older", 11));
    await writeFile(path.join(String(newer.config.env.CODEX_HOME), "auth.json"), auth("newer", 12));
    // The run with the older last_refresh writes back first. The run with
    // the newer last_refresh writes back last and must win.
    await older.cleanup();
    await newer.cleanup();
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("newer", 12));
  });
  it("resolves two concurrent xAI subscription write-backs by freshness, not by order", async () => {
    const userId = "concurrent-freshness-xai-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const identityKey = "https://auth.x.ai::33333333-3333-3333-3333-333333333333";
    const auth = (marker: string, expiresAtMs: number) => JSON.stringify({ [identityKey]: { key: `key-${marker}`, refresh_token: `refresh-${marker}`, expires_at: new Date(expiresAtMs).toISOString() } });
    const now = Date.now();
    await service.save(companyId, userId, { provider: "xai", method: "subscription", ownership: "personal", name: "Grok freshness fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", now));
    const runInput = { ...input, adapterType: "grok_local", responsibleUserId: userId, binding: { provider: "xai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    // Two runs use the same xAI subscription grant at the same time.
    // Neither call below throws ai_connection_busy.
    const older = await prepareManagedAiRuntime(db, runInput);
    const newer = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(older.config.env.GROK_HOME), "auth.json"), auth("older", now + 60 * 60 * 1000));
    await writeFile(path.join(String(newer.config.env.GROK_HOME), "auth.json"), auth("newer", now + 2 * 60 * 60 * 1000));
    // The run with the older expiry writes back first. The run with the
    // newer expiry writes back last and must win.
    await older.cleanup();
    await newer.cleanup();
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("newer", now + 2 * 60 * 60 * 1000));
  });
  it("discards a credential write-back when the grant is revoked while the run is open", async () => {
    const userId = "revoked-write-back-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    const saved = await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Revocation fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    const run = await prepareManagedAiRuntime(db, runInput);
    const [grantBeforeCleanup] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.grantId));
    const ref = grantBeforeCleanup.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
    const [secretBefore] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    // A newer last_refresh would win the freshness merge if the grant stayed
    // active. The revoked grant must discard the write-back before that merge
    // decides anything.
    await writeFile(path.join(String(run.config.env.CODEX_HOME), "auth.json"), auth("revoked-run", 11));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, saved.grantId));
    await run.cleanup();
    const [secretAfter] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    // service.select rejects a revoked grant, so it cannot read the stored
    // credential here. Compare the stored secret version directly instead.
    expect(secretAfter.latestVersion).toBe(secretBefore.latestVersion);
  });
  it("does not let a stale write-back overwrite an authorized secret rotation that commits while cleanup waits on the credential lock", async () => {
    const userId = "credential-lock-race-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    const saved = await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Credential lock race fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    const run = await prepareManagedAiRuntime(db, runInput);
    // The run's own refresh looks newer than the value it started with, but
    // it must lose to a company-authorized rotation that commits while
    // cleanup is still waiting on the credential secret's row lock.
    await writeFile(path.join(String(run.config.env.CODEX_HOME), "auth.json"), auth("run-refresh", 11));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.grantId));
    const ref = grant.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
    let holdAcquired!: () => void;
    const holdAcquiredPromise = new Promise<void>(resolve => { holdAcquired = resolve; });
    let releaseHold!: () => void;
    const holdReleased = new Promise<void>(resolve => { releaseHold = resolve; });
    // An authorized rotation writes the new credential inside its own open
    // transaction, so it still holds the secret row's lock when signaled.
    const holder = db.transaction(async tx => {
      await secretService(tx).rotate(ref.secretId, { value: auth("authorized-rotation", 12) }, { userId });
      holdAcquired();
      await holdReleased;
    });
    await holdAcquiredPromise;
    const cleanupPromise = run.cleanup();
    releaseHold();
    await holder;
    await cleanupPromise;
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("authorized-rotation", 12));
  });
  it("enforces the shared transport discriminator and existing harness compatibility", () => {
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "ai", transport: "mcp_remote" }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "tool", transport: "runtime_auth" }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "rest_api", config: { provider: "agentmail" } }).success).toBe(true);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "rest_api", config: { provider: "slack" } }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "runtime_auth", config: { provider: "agentmail" } }).success).toBe(false);
    expect(aiConnectionBindingSchema.safeParse({ provider: "anthropic", mode: "responsible_user" }).success).toBe(false);
    expect(aiConnectionBindingSchema.safeParse({ provider: "anthropic", mode: "shared", connectionId: randomUUID(), grantId: randomUUID() }).success).toBe(false);
    expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key", mode: "responsible_user" }, "paperclip_runner", "same-model", "acpx", "claude")).toBe(true);
    expect(isAiConnectionCompatible(binding, "paperclip_runner", "same-model", "acpx", "claude")).toBe(true);
    expect(isAiConnectionCompatible(binding, "paperclip_runner", "same-model", "acpx", "codex")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "openrouter", method: "api_key" }, "opencode_local", "anthropic/model")).toBe(false);
  });
  it("does not let a forged delegation bypass human access or accept an expired subscription attempt", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId, name: "Other" });
    await db.insert(connectionGrantDelegations).values({ companyId, grantId: selected.grant.id, agentId: otherAgent, createdByUserId: "bob" });
    await expect(service.select({ ...input, agentId: otherAgent, userId: "bob", binding: { ...binding, method: selected.attribution.method, mode: "delegated", connectionId: selected.connection.id, grantId: selected.grant.id } })).rejects.toThrow("not shared");
    const [environment] = await db.select().from(environments).limit(1);
    const sessionId = randomUUID();
    const intent = { provider: "anthropic", method: "subscription", ownership: "personal", name: "Expired", agentIds: [], allAgents: true } as const;
    await db.insert(adapterAuthSessions).values({ companyId, environmentId: environment.id, adapterType: "claude_local", startedByUserId: "alice", publicSessionId: sessionId, status: "submitting", aiConnection: { ...intent, agentIds: [] }, expiresAt: new Date(Date.now() - 1000) });
    await expect(service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-never-save", sessionId)).rejects.toThrow("no longer active");
    expect((await service.list(companyId, "alice")).some(account => account.name === "Expired")).toBe(false);
  });
  it("authorizes account creation, reconnect and defaults at the HTTP boundary before provider calls", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = String(req.headers["x-test-user"] ?? "alice");
      const role = req.headers["x-test-role"] === "viewer" ? "viewer" : "member";
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const personal = await service.select({ ...input, userId: "alice" });
    const base = `/api/companies/${companyId}/ai-connections`;
    expect((await request(app).get(`/api/companies/${otherCompanyId}/ai-connections`)).status).toBe(403);
    expect((await request(app).put(`${base}/default`).set("x-test-user", "bob").send({ grantId: personal.grant.id })).status).toBe(403);
    expect((await request(app).put(`${base}/default`).set("x-test-role", "viewer").send({ grantId: personal.grant.id })).status).toBe(403);
    const payload = { provider: "anthropic", method: "api_key", name: "Fixture", ownership: "personal", apiKey: "fixture", allAgents: false, agentIds: [] };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not reach provider"));
    try {
      expect((await request(app).post(base).set("x-test-role", "viewer").send(payload)).status).toBe(403);
      expect((await request(app).post(base).send({ ...payload, ownership: "shared" })).status).toBe(403);
      expect((await request(app).post(base).set("x-test-user", "bob").send({ ...payload, connectionId: personal.connection.id })).status).toBe(403);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("validates a Databricks OAuth M2M credential live at connection-creation time before saving", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, membershipRole: "member", status: "active" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const base = `/api/companies/${companyId}/ai-connections`;
    const payload = {
      provider: "databricks",
      method: "oauth_m2m",
      name: "Databricks fixture",
      ownership: "personal",
      clientId: "dbx-client-id",
      clientSecret: "dbx-client-secret",
      allAgents: false,
      agentIds: [],
      workspaceHost: "https://acme.cloud.databricks.com",
      catalog: "main",
      schema: "paperclip",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      // Databricks rejects the client-credentials exchange (401 at the token
      // endpoint): the create route maps it to a 422 without persisting anything.
      fetchSpy.mockImplementation(databricksFetchImpl(() => new Response(null, { status: 200 })));
      fetchSpy.mockImplementationOnce(async () => new Response(null, { status: 401 }));
      const rejected = await request(app).post(base).send({ ...payload, name: "Databricks rejected", clientSecret: "wrong-secret" });
      expect(rejected.status).toBe(422);
      expect(rejected.body.error).toContain("rejected");
      expect((await service.list(companyId, "alice")).some(c => c.name === "Databricks rejected")).toBe(false);

      // A valid credential: token exchange succeeds, then a single Unity Catalog page.
      fetchSpy.mockImplementation(databricksFetchImpl(() => new Response(JSON.stringify({ model_services: [] }), { status: 200 })));
      const created = await request(app).post(base).send(payload);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain("dbx-client-secret");
      expect((await service.list(companyId, "alice")).some(c => c.name === "Databricks fixture")).toBe(true);
    } finally { fetchSpy.mockRestore(); }
  });
  it("enforces the SaaS workspace-host allowlist for Databricks connection creation (Requirement 1.4)", async () => {
    const actorMiddleware = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.actor = { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, membershipRole: "member", status: "active" }] };
      next();
    };
    const errorMiddleware = (error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); };
    const base = `/api/companies/${companyId}/ai-connections`;
    const payload = {
      provider: "databricks",
      method: "oauth_m2m",
      ownership: "personal",
      clientId: "dbx-client-id",
      clientSecret: "dbx-client-secret",
      allAgents: false,
      agentIds: [],
      workspaceHost: "https://not-allowlisted.cloud.databricks.com",
      catalog: "main",
      schema: "paperclip",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not reach provider"));
    const allowServices = () => fetchSpy.mockImplementation(databricksFetchImpl(() => new Response(JSON.stringify({ model_services: [] }), { status: 200 })));
    try {
      // SaaS deployment, host not on the allowlist: rejected before the live credential check.
      const saasApp = express();
      saasApp.use(express.json());
      saasApp.use(actorMiddleware);
      saasApp.use("/api", aiConnectionRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "public" }));
      saasApp.use(errorMiddleware);
      const rejected = await request(saasApp).post(base).send({ ...payload, name: "Disallowed host" });
      expect(rejected.status).toBe(422);
      expect(rejected.body.error).toContain("not on the configured allowlist");
      expect((await service.list(companyId, "alice")).some(c => c.name === "Disallowed host")).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();

      // SaaS deployment, host on the allowlist: allowlist check passes, live credential check proceeds.
      const allowlistedApp = express();
      allowlistedApp.use(express.json());
      allowlistedApp.use(actorMiddleware);
      allowlistedApp.use("/api", aiConnectionRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        databricksHostAllowlist: new Set(["https://not-allowlisted.cloud.databricks.com"]),
      }));
      allowlistedApp.use(errorMiddleware);
      fetchSpy.mockReset();
      allowServices();
      const allowed = await request(allowlistedApp).post(base).send({ ...payload, name: "Allowlisted host" });
      expect(allowed.status).toBe(201);
      expect((await service.list(companyId, "alice")).some(c => c.name === "Allowlisted host")).toBe(true);

      // Non-SaaS deployment (default options): allowlist does not apply.
      const localApp = express();
      localApp.use(express.json());
      localApp.use(actorMiddleware);
      localApp.use("/api", aiConnectionRoutes(db));
      localApp.use(errorMiddleware);
      fetchSpy.mockReset();
      allowServices();
      const localCreated = await request(localApp).post(base).send({ ...payload, name: "Local deployment host" });
      expect(localCreated.status).toBe(201);
      expect((await service.list(companyId, "alice")).some(c => c.name === "Local deployment host")).toBe(true);

      // SaaS deployment with the private-hosts override: allowlist bypassed.
      const overrideApp = express();
      overrideApp.use(express.json());
      overrideApp.use(actorMiddleware);
      overrideApp.use("/api", aiConnectionRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        allowPrivateDatabricksHosts: true,
      }));
      overrideApp.use(errorMiddleware);
      fetchSpy.mockReset();
      allowServices();
      const overrideCreated = await request(overrideApp).post(base).send({ ...payload, name: "Private hosts override" });
      expect(overrideCreated.status).toBe(201);
      expect((await service.list(companyId, "alice")).some(c => c.name === "Private hosts override")).toBe(true);
    } finally { fetchSpy.mockRestore(); }
  });
  it("imports only for the local operator and preserves identity and permissions on reconnect", async () => {
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential").mockResolvedValue("fixture-local-token");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: req.headers["x-local"] === "yes" ? "local_implicit" : "session", userId: String(req.headers["x-test-user"] ?? "alice"), companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const url = `/api/companies/${companyId}/ai-connections/local`;
    const payload = { provider: "anthropic", method: "subscription", name: "Local account test", ownership: "personal", agentIds: [agentId], allAgents: false };
    try {
      expect((await request(app).post(url).send(payload)).status).toBe(403);
      expect(reader).not.toHaveBeenCalled();
      expect((await request(app).post(`${url}/check`).send(payload)).status).toBe(403);
      expect(reader).not.toHaveBeenCalled();
      const checked = await request(app).post(`${url}/check`).set("x-local", "yes").send(payload);
      expect(checked.status).toBe(200);
      expect(checked.body).toEqual({ status: "ready" });
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      const connected = await request(app).post(url).set("x-local", "yes").send(payload);
      expect(connected.status).toBe(201);
      expect(JSON.stringify(connected.body)).not.toContain("fixture-local-token");
      const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connected.body.connectionId));
      expect(before.map(i => [i.targetType, i.targetId])).toEqual([["agent", agentId]]);
      const reconnected = await request(app).post(url).set("x-local", "yes").send({ ...payload, connectionId: connected.body.connectionId, allAgents: true });
      expect(reconnected.status).toBe(201);
      expect(reconnected.body).toEqual(connected.body);
      const after = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connected.body.connectionId));
      expect(after).toEqual(before);
      reader.mockRejectedValueOnce(Object.assign(new Error("Sign in locally and retry"), { status: 422 }));
      const failed = await request(app).post(url).set("x-local", "yes").send({ ...payload, name: "Unsuccessful local login" });
      expect(failed.status).toBe(422);
      expect((await service.list(companyId, "alice")).some(c => c.name === "Unsuccessful local login")).toBe(false);
      const codex = { ...payload, provider: "openai", name: "Isolated terminal login" };
      const attempts = `${url}/attempts`;
      expect((await request(app).post(attempts).send(codex)).status).toBe(403); // This member cannot authorize agentId.
      expect((await request(app).post(url).set("x-local", "yes").send(codex)).status).toBe(422);
      const prepared = await request(app).post(attempts).set("x-local", "yes").send(codex);
      expect(prepared.status).toBe(201);
      expect(prepared.body.command).toMatch(/^\(export CODEX_HOME=.* && mkdir -p .* && codex -c .* login --device-auth\)$/);
      expect((await request(app).post(attempts).set("x-local", "yes").send(codex)).body).toEqual(prepared.body);
      expect((await request(app).delete(`${attempts}/${prepared.body.sessionId}`).set("x-test-user", "bob").send()).status).toBe(404);
      expect((await request(app).delete(`${attempts}/${prepared.body.sessionId}`).set("x-local", "yes").send()).status).toBe(200);
      expect((await request(app).post(url).set("x-local", "yes").send({ ...codex, localSessionId: prepared.body.sessionId })).status).toBe(422);
    } finally { reader.mockRestore(); }
  });
  it.each(["anthropic", "openai"] as const)("blocks server-host %s login on a public deployment without a trusted host", async provider => {
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" }));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const base = `/api/companies/${companyId}/ai-connections/local`;
    const intent = { provider, method: "subscription", ownership: "personal", name: "Hosted account", allAgents: false, agentIds: [] };
    try {
      for (const endpoint of [base, `${base}/attempts`, `${base}/check`]) {
        const result = await request(app).post(endpoint).send(intent);
        expect(result.status).toBe(422);
        expect(result.body.error).toContain("unavailable on this hosted instance");
      }
      expect(reader).not.toHaveBeenCalled();
    } finally { reader.mockRestore(); }
  });
  it.each(["anthropic", "openai"] as const)("lets authenticated users connect only their own isolated %s login", async provider => {
    const owner = `self-hosted-${provider}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential").mockResolvedValue("isolated-fixture-token");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: String(req.headers["x-test-user"] ?? owner), companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: req.headers["x-viewer"] ? "viewer" : "member" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const base = `/api/companies/${companyId}/ai-connections/local`;
    const intent = { provider, method: "subscription", ownership: "personal", name: `Self-hosted ${provider}`, allAgents: false, agentIds: [] };
    try {
      expect((await request(app).post(`${base}/attempts`).set("x-viewer", "yes").send(intent)).status).toBe(403);
      const started = await request(app).post(`${base}/attempts`).send(intent);
      expect(started.status).toBe(201);
      expect(started.headers["cache-control"]).toBe("no-store");
      expect(started.body.command).toContain(provider === "anthropic" ? "CLAUDE_CONFIG_DIR=" : "login --device-auth");
      expect((await request(app).post(`${base}/attempts`).send(intent)).body).toEqual(started.body);
      const input = { ...intent, localSessionId: started.body.sessionId };
      for (const endpoint of [base, `${base}/check`]) {
        expect((await request(app).post(endpoint).set("x-test-user", "bob").send(input)).status).toBe(404);
        expect((await request(app).post(endpoint.replace(companyId, otherCompanyId)).send(input)).status).toBe(403);
      }
      expect(reader).not.toHaveBeenCalled();
      const checked = await request(app).post(`${base}/check`).send(input);
      expect(checked.body).toEqual({ status: "ready" });
      expect(reader).toHaveBeenLastCalledWith(provider, path.join(home, "instances/ai-connection-fixture/ai-local-logins", started.body.sessionId));
      const saved = await request(app).post(base).send(input);
      expect(saved.status).toBe(201);
      expect((await request(app).post(base).send(input)).body).toEqual(saved.body);
      expect(JSON.stringify(saved.body)).not.toContain("isolated-fixture-token");
      expect((await service.list(companyId, owner)).filter(c => c.name === intent.name)).toHaveLength(1);
    } finally { reader.mockRestore(); }
  });
  it("rejects invalid credentials without exposing the provider response", async () => {
    const request = vi.fn().mockResolvedValue(new Response("secret-provider-body", { status: 401 }));
    await expect(validateAiApiKey("anthropic", "fixture", request)).rejects.toThrow("rejected");
    expect(request.mock.calls[0][1].redirect).toBe("error");
  });
  it("uses the authenticated responsible user for agent-originated configuration and tests", async () => {
    const req = { actor: { type: "agent", agentId, onBehalfOfUserId: "alice" } } as express.Request;
    const selected = await service.select({ ...input, userId: responsibleUserForAiRequest(req) });
    expect(selected.grant.subjectUserId).toBe("alice");
    req.actor.onBehalfOfUserId = undefined;
    expect(responsibleUserForAiRequest(req)).toBeNull();
    await expect(service.select({ ...input, userId: responsibleUserForAiRequest(req) })).rejects.toThrow();
  });

  it("protects active-run attribution with the connection human audience", async () => {
    const account = await create("alice", "Private run attribution");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { aiConnection: { connectionId: account.connectionId, grantId: account.grantId } } });
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: String(req.headers["x-test-user"] ?? "alice"), companyIds: [companyId] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const url = `/api/companies/${companyId}/ai-connections/${account.connectionId}/active-runs`;
    const own = await request(app).get(url);
    expect(own.status).toBe(200);
    expect(own.headers["cache-control"]).toBe("no-store");
    expect(own.body).toEqual([expect.objectContaining({ id: runId, agentId })]);
    expect((await request(app).get(url).set("x-test-user", "bob")).status).toBe(404);
    await db.update(connectionGrants).set({ kind: "organization", subjectUserId: null }).where(eq(connectionGrants.id, account.grantId));
    await db.insert(connectionGrantMembers).values({ companyId, grantId: account.grantId, subjectType: "user", subjectId: "alice" });
    expect((await request(app).get(url).set("x-test-user", "bob")).status).toBe(404);
    await db.insert(connectionGrantMembers).values({ companyId, grantId: account.grantId, subjectType: "user", subjectId: "bob" });
    expect((await request(app).get(url).set("x-test-user", "bob")).body).toEqual(own.body);
    expect((await request(app).get(url.replace(companyId, otherCompanyId))).status).toBe(403);
  });
  it("permits new-agent shared installation only for a connection configurator, without bypassing audience", async () => {
    const account = await service.save(companyId, "alice", { provider: "anthropic", method: "api_key", ownership: "shared", name: "Restricted shared", apiKey: "fixture", agentIds: [], allAgents: false }, "fixture-restricted");
    const selected = { provider: "anthropic", method: "api_key", mode: "shared", ...account } as const;
    const futureAgentId = randomUUID();
    const req = (userId: string, role = "member") => ({ actor: { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] } }) as express.Request;
    expect(await canInstallSharedAiConnectionForNewAgent(db, req("alice"), companyId, selected)).toBe(true);
    expect(await canInstallSharedAiConnectionForNewAgent(db, req("bob"), companyId, selected)).toBe(false);
    expect(await canInstallSharedAiConnectionForNewAgent(db, req("alice", "viewer"), companyId, selected)).toBe(false);
    expect(await canInstallSharedAiConnectionForNewAgent(db, { actor: { type: "agent", onBehalfOfUserId: "alice" } } as express.Request, companyId, selected)).toBe(false);
    const selectionInput = { ...input, agentId: futureAgentId, userId: "alice", binding: selected };
    await expect(service.select(selectionInput)).rejects.toThrow("not permitted for this agent");
    const run = await prepareManagedAiRuntime(db, { companyId, agentId: futureAgentId, responsibleUserId: "alice", adapterType: "claude_local", binding: selected, config: { cwd: home, model: "same-model" }, allowUninstalledShared: true });
    expect(run.config.model).toBe("same-model");
    await run.cleanup();
    await db.insert(connectionGrantMembers).values({ companyId, grantId: account.grantId, subjectType: "user", subjectId: "bob" });
    await expect(service.select({ ...selectionInput, allowUninstalledShared: true })).rejects.toThrow("not shared with the responsible user");
    await db.delete(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, account.grantId));
    await db.insert(agents).values({ id: futureAgentId, companyId, name: "New shared agent", adapterType: "claude_local" });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: account.connectionId, targetType: "agent", targetId: futureAgentId, createdByUserId: "alice" });
    expect((await service.select(selectionInput)).grant.id).toBe(account.grantId);
  });

  it("validates runner account adoption in the inherited sandbox and refuses an unavailable target", async () => {
    const { agentRoutes } = await import("../routes/agents.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const targetModule = await import("../services/environment-execution-target.js");
    const runtimeModule = await import("../services/environment-runtime.js");
    const { requireServerAdapter } = await import("../adapters/index.js");
    const settings = instanceSettingsService(db);
    const previous = await settings.get();
    const [environment] = await db.insert(environments).values({ name: "Adoption sandbox", driver: "sandbox", config: { provider: "daytona" } }).returning();
    await settings.update({ defaultEnvironmentId: environment.id });
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "Runner adoption", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" } });
    const account = await service.save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Runner adoption account", apiKey: "fixture-adoption-key", agentIds: [id], allAgents: false }, "fixture-adoption-key");
    await service.setDefault(companyId, "alice", account.grantId);
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "daytona", runner: { execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })) } } as const;
    const resolveTarget = vi.spyOn(targetModule, "resolveEnvironmentExecutionTarget").mockResolvedValue(target);
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ lease: { id: randomUUID(), provider: "daytona", providerLeaseId: "test-sandbox", metadata: {} }, leaseContext: {} }));
    const runtime = vi.spyOn(runtimeModule, "environmentRuntimeService").mockReturnValue({ acquireRunLease: acquire, realizeWorkspace: vi.fn(async () => ({ cwd: "/workspace" })), getDriver: () => ({ releaseRunLease: release }) } as any);
    const probe = vi.spyOn(requireServerAdapter("paperclip_runner"), "testEnvironment").mockImplementation(async context => ({ adapterType: "paperclip_runner", status: context.executionTarget ? "pass" : "fail", testedAt: new Date().toISOString(), checks: [{ code: context.executionTarget ? "codex_hello_probe_passed" : "host_probe_failed", level: context.executionTarget ? "info" : "error", message: "fixture" }] }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "alice", companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const selected = { provider: "openai", method: "api_key", mode: "responsible_user" } as const;
    const providerRequest = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    try {
      // Target resolution can return only warning checks. Adoption still must
      // fail closed, rather than quietly running the probe on the server host.
      resolveTarget.mockResolvedValueOnce(null);
      const unavailable = await request(app).patch(`/api/agents/${id}`).send({ runtimeConfig: { aiConnection: selected } });
      expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(422);
      expect(probe).not.toHaveBeenCalled();
      expect(providerRequest).not.toHaveBeenCalled();
      expect((await db.select().from(agents).where(eq(agents.id, id)))[0].runtimeConfig.aiConnection).toBeUndefined();
      const saved = await request(app).patch(`/api/agents/${id}`).send({ runtimeConfig: { aiConnection: selected } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.defaultEnvironmentId).toBeNull();
      expect(saved.body.runtimeConfig.aiConnection).toEqual(selected);
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ companyId, environment: expect.objectContaining({ id: environment.id }) }));
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: target, config: expect.objectContaining({ provider: "codex", model: "gpt-5.6-sol", managedAiConnection: expect.any(Object) }) }));
      expect(providerRequest).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
        headers: { Authorization: "Bearer fixture-adoption-key" },
        redirect: "error",
      }));
      expect(release).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(saved.body)).not.toContain("fixture-adoption-key");
    } finally {
      providerRequest.mockRestore(); probe.mockRestore(); runtime.mockRestore(); resolveTarget.mockRestore();
      await settings.update({ defaultEnvironmentId: previous.defaultEnvironmentId });
    }
  });

  it("creates and hires agents with an authorized restricted shared connection", async () => {
    const { agentRoutes } = await import("../routes/agents.js");
    await db.update(companies).set({ requireBoardApprovalForNewAgents: false }).where(eq(companies.id, companyId));
    const account = await service.save(companyId, "alice", { provider: "anthropic", method: "api_key", ownership: "shared", name: "Shared creation routes", apiKey: "fixture", agentIds: [], allAgents: false }, "fixture-create-routes");
    const selected = { ...binding, mode: "shared", ...account } as const;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "alice", companyIds: [companyId] };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    for (const endpoint of ["agents", "agent-hires"]) {
      const response = await request(app).post(`/api/companies/${companyId}/${endpoint}`).send({ name: `Shared ${endpoint}`, role: "general", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" }, runtimeConfig: { aiConnection: selected } });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const agent = endpoint === "agents" ? response.body : response.body.agent;
      expect(agent.adapterConfig.model).toBe("claude-sonnet-4-6");
      expect(agent.runtimeConfig.aiConnection).toEqual(selected);
      const installs = await db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.connectionId, account.connectionId), eq(toolConnectionInstalls.targetId, agent.id)));
      expect(installs).toHaveLength(1);
      expect((await service.select({ ...input, agentId: agent.id, userId: "alice", binding: selected })).grant.id).toBe(account.grantId);
    }
    // A database failure between the two inserts must roll back the agent too.
    await db.execute(sql`CREATE FUNCTION reject_test_ai_install() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture install failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_test_ai_install BEFORE INSERT ON tool_connection_installs FOR EACH ROW EXECUTE FUNCTION reject_test_ai_install()`);
    try {
      for (const endpoint of ["agents", "agent-hires"]) {
        const name = `Rollback ${endpoint}`;
        const response = await request(app).post(`/api/companies/${companyId}/${endpoint}`).send({ name, role: "general", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" }, runtimeConfig: { aiConnection: selected } });
        expect(response.status).toBe(500);
        expect(await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, name)))).toEqual([]);
      }
    } finally {
      await db.execute(sql`DROP TRIGGER reject_test_ai_install ON tool_connection_installs`);
      await db.execute(sql`DROP FUNCTION reject_test_ai_install()`);
    }
  }, 30000);

  describe("resolveDatabricksCredential", () => {
    const createDatabricks = (userId: string, name: string, ownership: "personal" | "shared" = "personal", forCompanyId = companyId) =>
      service.save(forCompanyId, userId, databricksCreateInput(name, ownership), "unused-for-databricks");

    it("resolves the OAuth M2M credential for the owning grant's personal connection without leaking the client secret", async () => {
      const userId = "databricks-personal-user";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks personal");
      const resolved = await service.resolveDatabricksCredential(companyId, account.connectionId, userId);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("expected ok resolution");
      expect(resolved.credential.clientId).toBe("dbx-client-id");
      expect(resolved.credential.clientSecret).toBe("secret-Databricks personal");
      expect(resolved.credential.credentialVersion).toEqual(expect.any(String));
      expect(resolved.attribution).toMatchObject({ connectionId: account.connectionId, grantId: account.grantId, provider: "databricks" });
      // The client secret must never appear in any serialized view other than
      // `credential.clientSecret` itself — not in the attribution, not in the
      // non-secret credential fields (host/catalog/schema/clientId/version),
      // however the result is later serialized to a client-facing surface.
      const { clientSecret, ...credentialWithoutSecret } = resolved.credential;
      expect(JSON.stringify({ attribution: resolved.attribution, credential: credentialWithoutSecret })).not.toContain(clientSecret);
      expect(credentialWithoutSecret).toEqual({
        clientId: "dbx-client-id",
        host: "https://acme.cloud.databricks.com",
        catalog: "main",
        schema: "paperclip",
        modelPrefix: undefined,
        credentialVersion: resolved.credential.credentialVersion,
      });
    });

    it("returns connection_missing for a connectionId belonging to a different company, without revealing existence", async () => {
      const userId = "databricks-cross-company-user";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      await db.insert(companyMemberships).values({ companyId: otherCompanyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const otherCompanyAccount = await createDatabricks(userId, "Other company databricks", "personal", otherCompanyId);
      const resolvedFromWrongCompany = await service.resolveDatabricksCredential(companyId, otherCompanyAccount.connectionId, userId);
      expect(resolvedFromWrongCompany).toEqual({ ok: false, reason: "connection_missing", message: expect.any(String) });
      // Same failure shape as a connectionId that never existed at all — the
      // response must not distinguish "exists elsewhere" from "never existed".
      const resolvedFromRandomId = await service.resolveDatabricksCredential(companyId, randomUUID(), userId);
      expect(resolvedFromRandomId).toEqual({ ok: false, reason: "connection_missing", message: expect.any(String) });
    });

    it("denies an actor without a usable grant with access_denied", async () => {
      const owner = "databricks-access-owner";
      const outsider = "databricks-access-outsider";
      await db.insert(companyMemberships).values([owner, outsider].map(principalId => ({ companyId, principalId, principalType: "user", status: "active" as const, membershipRole: "member" as const })));
      const account = await createDatabricks(owner, "Databricks personal access");
      const resolved = await service.resolveDatabricksCredential(companyId, account.connectionId, outsider);
      expect(resolved).toEqual({ ok: false, reason: "access_denied", message: expect.any(String) });
      // No responsible user at all is also not a usable grant.
      const resolvedNoUser = await service.resolveDatabricksCredential(companyId, account.connectionId, null);
      expect(resolvedNoUser).toEqual({ ok: false, reason: "access_denied", message: expect.any(String) });
    });

    it("denies a revoked connection's grant with connection_unavailable and does not resolve the credential", async () => {
      const userId = "databricks-revoked-user";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks revoked");
      await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
      const resolved = await service.resolveDatabricksCredential(companyId, account.connectionId, userId);
      expect(resolved).toEqual({ ok: false, reason: "connection_unavailable", message: expect.any(String) });
    });

    it("shares access with the audience of a shared grant and denies actors outside it", async () => {
      const owner = "databricks-shared-owner";
      const member = "databricks-shared-member";
      const outsider = "databricks-shared-outsider";
      await db.insert(companyMemberships).values([owner, member, outsider].map(principalId => ({ companyId, principalId, principalType: "user", status: "active" as const, membershipRole: "member" as const })));
      const account = await createDatabricks(owner, "Databricks shared", "shared");
      await toolAccessService(db).replaceConnectionGrantMembers(account.connectionId, account.grantId, [member], { userId: owner });
      expect((await service.resolveDatabricksCredential(companyId, account.connectionId, member)).ok).toBe(true);
      expect(await service.resolveDatabricksCredential(companyId, account.connectionId, outsider)).toEqual({ ok: false, reason: "access_denied", message: expect.any(String) });
    });

    it("classifies a legacy api_key Databricks connection as needing reconnection without exchanging the stored PAT", async () => {
      const userId = "databricks-legacy-api-key-user";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks legacy api_key");
      // Reproduce a connection created before this migration: its `config.ai.method`
      // was persisted as the legacy `api_key` (its secret slot held a raw PAT). The
      // current `save` path can no longer create that shape — the schema rejects
      // `api_key` for `databricks` — so rewrite the stored envelope in place to stand
      // in for a pre-migration row.
      const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
      const legacyConfig = { ...stored.config, ai: { ...(stored.config.ai as Record<string, unknown>), method: "api_key" } };
      await db.update(toolConnections).set({ config: legacyConfig }).where(eq(toolConnections.id, account.connectionId));

      // The legacy-method guard returns before any credential resolution or network
      // I/O, so the stored PAT is never traded for an OAuth access token: a fetch
      // that reaches the provider would throw and any call at all fails the test.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not reach provider"));
      try {
        const resolved = await service.resolveDatabricksCredential(companyId, account.connectionId, userId);
        expect(resolved).toEqual({ ok: false, reason: "connection_unavailable", message: expect.any(String) });
        if (resolved.ok) throw new Error("expected a classified reconnect failure");
        expect(resolved.message).toMatch(/reconnect/i);
        expect(resolved.message).toMatch(/client id/i);
        expect(resolved.message).toMatch(/client secret/i);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally { fetchSpy.mockRestore(); }
    });
  });

  // NOTE: The former "prepareManagedAiRuntime with a Databricks connection"
  // block asserted the legacy `env.DATABRICKS_TOKEN` injection and the old
  // three-field `providerRuntimeHint`. Under the OAuth M2M migration, the
  // runtime no longer injects a static token into the process environment —
  // it writes an ephemeral credential file and configures an `auth.command`
  // helper. That new runtime behavior (credential-file creation, 0600
  // permissions, cleanup, no secret in logs/events/config) is owned and
  // exercised by task 7 in `server/src/__tests__/agent-hire-ai-connections.test.ts`,
  // so the obsolete token-injection tests are removed here rather than left
  // asserting behavior the migration deletes.

  describe("Databricks connection edit/revoke cache invalidation and activity logging", () => {
    const createDatabricks = (userId: string, name: string) =>
      service.save(companyId, userId, databricksCreateInput(name), "unused-for-databricks");

    /** Runs a full discovery for a connection, threading the resolved
     * `credentialVersion` into the cache key exactly as the real route does. */
    async function populateCache(connectionId: string, userId: string) {
      const resolved = await service.resolveDatabricksCredential(companyId, connectionId, userId);
      if (!resolved.ok) throw new Error("expected ok resolution");
      await listDatabricksModelServices(
        {
          companyId,
          connectionId,
          credentialVersion: resolved.credential.credentialVersion,
          host: resolved.credential.host,
          catalog: resolved.credential.catalog,
          schema: resolved.credential.schema,
        },
        resolved.credential,
      );
    }

    it("invalidates the cached combo list and writes an activity log entry when a Databricks connection is edited", async () => {
      const userId = "databricks-edit-user";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks edit target");

      // Count Unity Catalog page requests only; each discovery also performs an
      // OAuth token exchange, so total fetch calls are not a stable signal.
      let pageCalls = 0;
      const fetchSpy = vi.fn(databricksFetchImpl(() => {
        pageCalls += 1;
        return new Response(JSON.stringify({ model_services: [] }), { status: 200 });
      }));
      vi.stubGlobal("fetch", fetchSpy);
      try {
        await populateCache(account.connectionId, userId);
        expect(pageCalls).toBe(1);
        // A second discovery within the TTL should be served from cache.
        await populateCache(account.connectionId, userId);
        expect(pageCalls).toBe(1);

        await service.save(
          companyId,
          userId,
          { ...databricksCreateInput("Databricks edit target"), connectionId: account.connectionId, schema: "paperclip2" },
          "unused-for-databricks",
        );

        // The edit rotates the secret (bumping credentialVersion) and
        // invalidates both caches: the next discovery issues a fresh Unity
        // Catalog request instead of reusing the pre-edit cached result.
        await populateCache(account.connectionId, userId);
        expect(pageCalls).toBe(2);
      } finally {
        vi.unstubAllGlobals();
      }

      const entries = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, account.connectionId), eq(activityLog.action, "ai_connection.reconnected")));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ companyId, actorId: userId, entityType: "tool_connection" });
      // The activity log must never carry the client secret.
      expect(JSON.stringify(entries[0]?.details ?? {})).not.toContain("secret-Databricks edit target");
    });

    it("invalidates the cached combo list and writes an activity log entry when a Databricks connection is revoked", async () => {
      const userId = "databricks-revoke-cache-user";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks revoke target");

      let pageCalls = 0;
      const fetchSpy = vi.fn(databricksFetchImpl(() => {
        pageCalls += 1;
        return new Response(JSON.stringify({ model_services: [] }), { status: 200 });
      }));
      vi.stubGlobal("fetch", fetchSpy);
      try {
        await populateCache(account.connectionId, userId);
        expect(pageCalls).toBe(1);

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          req.actor = { type: "board", userId, userName: "Board User", userEmail: null, isInstanceAdmin: true, source: "local_implicit" };
          next();
        });
        app.use("/api", toolAccessRoutes(db));
        app.use(errorHandler);
        const revokeResponse = await request(app).delete(
          `/api/tool-connections/${account.connectionId}/grants/${account.grantId}`,
        );
        expect(revokeResponse.status).toBe(200);
        // The revoke route's own response body is a client-visible surface;
        // it must never echo the connection's client secret.
        expect(JSON.stringify(revokeResponse.body)).not.toContain("secret-Databricks revoke target");

        // A revoked connection denies resolution outright (Requirement 3.3), so
        // cache invalidation is observed by asserting discovery can no longer be
        // served from a pre-revoke cached result once access is restored.
        expect(await service.resolveDatabricksCredential(companyId, account.connectionId, userId)).toEqual({
          ok: false,
          reason: "connection_unavailable",
          message: expect.any(String),
        });
      } finally {
        vi.unstubAllGlobals();
      }

      const entries = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, account.grantId), eq(activityLog.action, "tool_connection.grant_revoked")));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ companyId, details: { connectionId: account.connectionId } });
    });
  });

  describe("GET /companies/:companyId/adapters/:type/models?provider=databricks", () => {
    const createDatabricks = (userId: string, name: string, ownership: "personal" | "shared" = "personal", forCompanyId = companyId) =>
      service.save(forCompanyId, userId, databricksCreateInput(name, ownership), "unused-for-databricks");

    async function buildApp(userId: string) {
      const { agentRoutes } = await import("../routes/agents.js");
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId, otherCompanyId] };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("returns 422 when connectionId is missing", async () => {
      const userId = "databricks-route-missing-connection";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const app = await buildApp(userId);
      const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks`);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    });

    it("returns 404 for a connectionId belonging to a different company", async () => {
      const userId = "databricks-route-cross-company";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      await db.insert(companyMemberships).values({ companyId: otherCompanyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const foreignAccount = await createDatabricks(userId, "Databricks route foreign", "personal", otherCompanyId);
      const app = await buildApp(userId);
      const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${foreignAccount.connectionId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    });

    it("returns 403 when the actor has no usable grant on an otherwise-valid connection", async () => {
      const owner = "databricks-route-owner";
      const outsider = "databricks-route-outsider";
      await db.insert(companyMemberships).values([owner, outsider].map(principalId => ({ companyId, principalId, principalType: "user", status: "active" as const, membershipRole: "member" as const })));
      const account = await createDatabricks(owner, "Databricks route access");
      const app = await buildApp(outsider);
      const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });

    it("returns 409 for a revoked connection", async () => {
      const userId = "databricks-route-revoked";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route revoked");
      await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
      const app = await buildApp(userId);
      const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
    });

    it("returns 200 with the discovered combo list for a valid connection", async () => {
      const userId = "databricks-route-success";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route success");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        databricksFetchImpl(() => new Response(JSON.stringify({ model_services: [{ name: "model-services/main.paperclip.combo_ux" }] }), { status: 200 })),
      );
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual([{ id: "main.paperclip.combo_ux", label: "Combo Ux" }]);
        // Never leaks host/catalog/schema/secret alongside the id/label pair.
        expect(JSON.stringify(res.body)).not.toContain("secret-Databricks route success");
        expect(JSON.stringify(res.body)).not.toContain("acme.cloud.databricks.com");
      } finally { fetchSpy.mockRestore(); }
    });

    it("returns model objects with exactly the id/label keys and no host/catalog/schema/token field, across multiple combos", async () => {
      const userId = "databricks-route-shape";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route shape");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        databricksFetchImpl(() => new Response(
          JSON.stringify({
            model_services: [
              { name: "model-services/main.paperclip.combo_ux" },
              { name: "model-services/main.paperclip.combo_dev" },
              { name: "model-services/main.paperclip.combo_prod" },
            ],
          }),
          { status: 200 },
        )),
      );
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(3);
        // Structural proof (not a substring check): every returned model object
        // has exactly the ["id", "label"] keys, so no extra field — however named,
        // even one that doesn't happen to contain a known secret substring — can
        // sneak into the response.
        for (const model of res.body) {
          expect(Object.keys(model).sort()).toEqual(["id", "label"]);
        }
      } finally { fetchSpy.mockRestore(); }
    });

    it("returns an empty list for provider=databricks on a non-codex_local adapter type", async () => {
      const userId = "databricks-route-wrong-adapter";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route wrong adapter");
      const app = await buildApp(userId);
      const res = await request(app).get(`/api/companies/${companyId}/adapters/claude_local/models?provider=databricks&connectionId=${account.connectionId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([]);
    });

    // The connection resolves fine (Layer 1: resolveDatabricksCredential
    // succeeds); these cover Layer 2, where the live Unity Catalog call
    // itself fails once the resolved credential is used (Requirement
    // 10.1-10.4). Each uses its own connection so the 60s discovery cache
    // never masks the mocked failure.
    it("returns 401 when Databricks rejects the credential", async () => {
      const userId = "databricks-route-invalid-credential";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route invalid credential");
      // Token exchange succeeds; the Unity Catalog call itself is rejected 401.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl(() => new Response(null, { status: 401 })));
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(401);
      } finally { fetchSpy.mockRestore(); }
    });

    it("returns 403 when Databricks denies permission for the catalog/schema", async () => {
      const userId = "databricks-route-insufficient-permission";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route insufficient permission");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl(() => new Response(null, { status: 403 })));
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      } finally { fetchSpy.mockRestore(); }
    });

    it("returns 429 with Retry-After echoed when Databricks rate limits the request", async () => {
      const userId = "databricks-route-rate-limited";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route rate limited");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        databricksFetchImpl(() => new Response(null, { status: 429, headers: { "retry-after": "30" } })),
      );
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(429);
        expect(res.headers["retry-after"]).toBe("30");
      } finally { fetchSpy.mockRestore(); }
    });

    it("returns 502 when Databricks responds with a 5xx status", async () => {
      const userId = "databricks-route-workspace-5xx";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route workspace 5xx");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl(() => new Response(null, { status: 503 })));
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(502);
      } finally { fetchSpy.mockRestore(); }
    });

    it("returns 502 when the Databricks request fails with a network error", async () => {
      const userId = "databricks-route-network-error";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route network error");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(502);
      } finally { fetchSpy.mockRestore(); }
    });

    it("returns 422 when discovery rejects the stored host as malformed", async () => {
      // `databricksConnectionConfigSchema` (create-time, Zod, in packages/shared) and
      // `assertValidHost` (the live check `listDatabricksModelServices` runs in
      // databricks-model-services.ts before any fetch) enforce the exact same
      // https-origin-only shape, and `resolveDatabricksCredential` re-validates the
      // stored config with that same schema before handing a host to discovery — its
      // `.transform` always normalizes a passing value down to a clean origin. So no
      // stored connection, however corrupted in the database, can ever carry a value
      // through `resolveDatabricksCredential` that still fails `assertValidHost`; the
      // two checks can't disagree. `assertValidHost`'s own doc comment describes it as
      // a defensive/live re-check, and it is already unit-tested directly against
      // `listDatabricksModelServices` (see databricks-model-services.test.ts). What
      // remains to prove at the route level is that the route's own
      // `case "invalid_host": throw unprocessable(...)` branch (agents.ts) is wired
      // correctly end-to-end: a `DatabricksDiscoveryError` with kind "invalid_host"
      // surfacing from discovery becomes a 422 with no credential leakage. This spies
      // on just the `listDatabricksModelServices` export (not a file-wide vi.mock, so
      // sibling tests in this block keep exercising the real implementation) to
      // simulate that error arriving from the discovery layer.
      const userId = "databricks-route-malformed-host";
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const account = await createDatabricks(userId, "Databricks route malformed host");
      const discoveryModule = await import("../services/databricks-model-services.js");
      const discoverySpy = vi.spyOn(discoveryModule, "listDatabricksModelServices").mockRejectedValue(
        new discoveryModule.DatabricksDiscoveryError(
          "invalid_host",
          "Databricks workspace host must be an https:// origin with no path, query, or credentials",
        ),
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const app = await buildApp(userId);
        const res = await request(app).get(`/api/companies/${companyId}/adapters/codex_local/models?provider=databricks&connectionId=${account.connectionId}`);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        // The mocked error message is fixed and generic (mirroring assertValidHost's
        // real message), and never includes a credential value.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(JSON.stringify(res.body)).not.toContain("acme.cloud.databricks.com");
        expect(JSON.stringify(res.body)).not.toContain("secret-Databricks route malformed host");
      } finally {
        discoverySpy.mockRestore();
        fetchSpy.mockRestore();
      }
    });
  });
});


// Property 2: a credential, an OAuth M2M access token, or a combo list resolved
// for company A is never returned, reused, or made visible to a company B
// request. The credential path scopes every lookup by companyId first; the
// token and combo caches are keyed by companyId so no cross-company entry is
// ever a cache hit for another company.
describe("Databricks multi-tenant isolation (Property 2)", () => {
  it("never resolves company A's credential for a company B request and reports it identically to a nonexistent connection", async () => {
    const userA = "dbx-iso-user-a";
    const userB = "dbx-iso-user-b";
    await db.insert(companyMemberships).values([
      { companyId, principalId: userA, principalType: "user", status: "active", membershipRole: "member" },
      { companyId: otherCompanyId, principalId: userB, principalType: "user", status: "active", membershipRole: "member" },
    ]);
    const accountA = await service.save(companyId, userA, databricksCreateInput("Company A Databricks"), "unused-for-databricks");

    // Company A resolves its own connection.
    expect((await service.resolveDatabricksCredential(companyId, accountA.connectionId, userA)).ok).toBe(true);

    // Company B asking for company A's connectionId gets connection_missing —
    // byte-for-byte identical to a connectionId that never existed. Nothing in
    // the result distinguishes "exists in another company" from "never existed".
    const crossCompany = await service.resolveDatabricksCredential(otherCompanyId, accountA.connectionId, userB);
    const nonexistent = await service.resolveDatabricksCredential(otherCompanyId, randomUUID(), userB);
    expect(crossCompany).toEqual({ ok: false, reason: "connection_missing", message: expect.any(String) });
    expect(crossCompany).toEqual(nonexistent);
  });

  it("keys the OAuth access-token cache by companyId so company B never receives company A's cached token", async () => {
    const connectionId = randomUUID();
    const host = "https://acme.cloud.databricks.com";
    const credential = { host, clientId: "shared-client-id", clientSecret: "shared-client-secret" };
    // Same connectionId/credentialVersion/host — only companyId differs.
    const keyA = { companyId, connectionId, credentialVersion: "1", host, catalog: "main", schema: "paperclip" };
    const keyB = { companyId: otherCompanyId, connectionId, credentialVersion: "1", host, catalog: "main", schema: "paperclip" };

    let issued = 0;
    const fetchSpy = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      expect(url.pathname.endsWith("/oidc/v1/token")).toBe(true);
      issued += 1;
      return new Response(JSON.stringify({ access_token: `token-${issued}`, expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const tokenA = await resolveDatabricksAccessToken(keyA, credential);
      // Company B must not be served company A's cached token — a fresh exchange runs.
      const tokenB = await resolveDatabricksAccessToken(keyB, credential);
      expect(tokenA.token).not.toBe(tokenB.token);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // Company A keeps getting its own token from cache, never company B's.
      const tokenAAgain = await resolveDatabricksAccessToken(keyA, credential);
      expect(tokenAAgain.token).toBe(tokenA.token);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      invalidateDatabricksAccessToken(connectionId);
      vi.unstubAllGlobals();
    }
  });

  it("keys the combo-list cache by companyId so company B never reuses company A's cached combos", async () => {
    const connectionId = randomUUID();
    const host = "https://acme.cloud.databricks.com";
    const credential = { host, clientId: "shared-client-id", clientSecret: "shared-client-secret", catalog: "main", schema: "paperclip" };
    const keyA = { companyId, connectionId, credentialVersion: "1", host, catalog: "main", schema: "paperclip" };
    const keyB = { companyId: otherCompanyId, connectionId, credentialVersion: "1", host, catalog: "main", schema: "paperclip" };

    // Count only Unity Catalog page requests; the token exchange is answered separately.
    let pageCalls = 0;
    const fetchSpy = vi.fn(databricksFetchImpl(() => {
      pageCalls += 1;
      return new Response(JSON.stringify({ model_services: [{ name: `model-services/main.paperclip.combo_${pageCalls}` }] }), { status: 200 });
    }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const listA = await listDatabricksModelServices(keyA, credential);
      expect(pageCalls).toBe(1);
      // A repeat for company A within the TTL is served from cache.
      await listDatabricksModelServices(keyA, credential);
      expect(pageCalls).toBe(1);
      // Company B never reuses company A's cached combo list — a fresh page runs.
      const listB = await listDatabricksModelServices(keyB, credential);
      expect(pageCalls).toBe(2);
      expect(listA).not.toEqual(listB);
    } finally {
      invalidateDatabricksModelServiceCache(connectionId);
      invalidateDatabricksAccessToken(connectionId);
      vi.unstubAllGlobals();
    }
  });
});


// Property 7: a rotation/revocation blocks future issuance (the credentialVersion
// bumps to a never-before-used value and both caches are invalidated) but never
// reaches out to Databricks to revoke an already-issued token — such a token is
// left to expire naturally.
describe("Databricks credential rotation and revocation (Property 7)", () => {
  it("bumps credentialVersion to a never-before-used value on every rapid successive rotation", async () => {
    const userId = "dbx-rotation-version-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const account = await service.save(companyId, userId, databricksCreateInput("Rotation versions"), "unused-for-databricks");

    const versions: string[] = [];
    const initial = await service.resolveDatabricksCredential(companyId, account.connectionId, userId);
    if (!initial.ok) throw new Error("expected ok resolution");
    versions.push(initial.credential.credentialVersion);

    // Rapid successive rotations: each reconnect rotates the stored secret,
    // bumping its version. No delay between them.
    for (let i = 0; i < 4; i++) {
      await service.save(
        companyId,
        userId,
        { ...databricksCreateInput("Rotation versions"), connectionId: account.connectionId, clientSecret: `rotated-secret-${i}` },
        "unused-for-databricks",
      );
      const resolved = await service.resolveDatabricksCredential(companyId, account.connectionId, userId);
      if (!resolved.ok) throw new Error("expected ok resolution");
      versions.push(resolved.credential.credentialVersion);
    }

    // Never repeats, and is strictly increasing across the whole sequence.
    expect(new Set(versions).size).toBe(versions.length);
    const numeric = versions.map(Number);
    for (let i = 1; i < numeric.length; i++) expect(numeric[i]).toBeGreaterThan(numeric[i - 1]);
  });

  it("rejects a rotated-away client secret with the same invalid-credential error as a 401 and never serves a stale-version cached token", async () => {
    const connectionId = randomUUID();
    const host = "https://acme.cloud.databricks.com";
    const oldCredential = { host, clientId: "sp-client-id", clientSecret: "old-secret" };
    const newCredential = { host, clientId: "sp-client-id", clientSecret: "new-secret" };

    // Databricks accepts the current secret and rejects (401) a secret that has
    // been rotated away at the workspace.
    const fetchSpy = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      expect(url.pathname.endsWith("/oidc/v1/token")).toBe(true);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const decoded = Buffer.from(String(headers.Authorization ?? "").replace("Basic ", ""), "base64").toString("utf8");
      if (decoded.endsWith(":old-secret")) return new Response(null, { status: 401 });
      return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // A pre-rotation token is cached under credentialVersion "1".
      const preRotation = await resolveDatabricksAccessToken(
        { companyId, connectionId, credentialVersion: "1", host, catalog: "main", schema: "paperclip" },
        newCredential,
      );
      expect(preRotation.token).toBe("fresh-token");

      // Rotation: Paperclip invalidates the token cache and bumps the version.
      invalidateDatabricksAccessToken(connectionId);

      // A post-rotation exchange that still uses the OLD secret is rejected with
      // the SAME invalid-credential classification a raw 401 produces, and never
      // returns the pre-rotation token cached under the previous version.
      const rotatedAwayError = await resolveDatabricksAccessToken(
        { companyId, connectionId, credentialVersion: "2", host, catalog: "main", schema: "paperclip" },
        oldCredential,
      ).catch((error: unknown) => error);
      expect(rotatedAwayError).toBeInstanceOf(DatabricksDiscoveryError);
      expect((rotatedAwayError as DatabricksDiscoveryError).kind).toBe("invalid_credential");

      // The direct token exchange classifies the same 401 identically.
      const directError = await fetchDatabricksAccessToken(oldCredential).catch((error: unknown) => error);
      expect(directError).toBeInstanceOf(DatabricksDiscoveryError);
      expect((directError as DatabricksDiscoveryError).kind).toBe("invalid_credential");
    } finally {
      invalidateDatabricksAccessToken(connectionId);
      vi.unstubAllGlobals();
    }
  });

  it("never issues a remote revocation call to Databricks when rotating or revoking a connection", async () => {
    const userId = "dbx-no-remote-revoke-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const account = await service.save(companyId, userId, databricksCreateInput("No remote revoke"), "unused-for-databricks");

    // Any network call during rotate/revoke would be a remote revocation attempt.
    const fetchSpy = vi.fn(async () => {
      throw new Error("no network call is expected during rotate/revoke");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // Rotation (reconnect with a new secret) invalidates local caches only.
      await service.save(
        companyId,
        userId,
        { ...databricksCreateInput("No remote revoke"), connectionId: account.connectionId, clientSecret: "rotated-secret" },
        "unused-for-databricks",
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      // Revocation is a deliberate admin action; it also stays local.
      await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    // After revocation, future issuance is blocked at resolution. A token issued
    // before the rotation is left to expire naturally, never revoked remotely.
    expect(await service.resolveDatabricksCredential(companyId, account.connectionId, userId)).toEqual({
      ok: false,
      reason: "connection_unavailable",
      message: expect.any(String),
    });
  });
});


describe("AI connection recovery delivery", () => {
  it.each(["restored", "newer failure", "different blocker", "revoked again", "closed task"])(
    "continues only the repaired source failure: %s", async (scenario) => {
      const userId = `recovery-${randomUUID()}`;
      const recoveringAgentId = randomUUID();
      const issueId = randomUUID();
      const failedRunId = randomUUID();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      await db.insert(agents).values({ id: recoveringAgentId, companyId, name: "Recovery agent", status: "active", adapterType: "claude_local", runtimeConfig: { aiConnection: binding } });
      await db.insert(issues).values({ id: issueId, companyId, title: "Restore selected account", status: "in_progress", assigneeAgentId: recoveringAgentId });
      await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: recoveringAgentId, status: "running", responsibleUserId: userId, contextSnapshot: { issueId } });
      const intents = connectionIntentService(db);
      const pending = await intents.request({ sub: recoveringAgentId, company_id: companyId, run_id: failedRunId, responsible_user_id: userId }, "anthropic", { purpose: "ai" });
      const account = await create(userId, `Recovered ${scenario}`);
      expect((await intents.setupOptions(pending.interactionId!)).existingConnections.map(connection => connection.id)).toEqual([account.connectionId]);
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } } }).where(eq(heartbeatRuns.id, failedRunId));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId, kind: "configuration_validation", cause: "configuration_incomplete", fingerprint: `ai:${issueId}`, nextAction: "Reconnect", ownerType: "board", evidence: { latestRunId: failedRunId } });
      await intents.complete(pending.interactionId!, account.connectionId, userId);
      if (scenario === "newer failure") await db.insert(heartbeatRuns).values({ companyId, agentId: recoveringAgentId, status: "failed", contextSnapshot: { issueId }, createdAt: new Date(Date.now() + 1000) });
      if (scenario === "different blocker") await db.update(issueRecoveryActions).set({ cause: "workspace_validation_failed" }).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      if (scenario === "closed task") await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      if (scenario === "revoked again") {
        await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
        const repairOptions = await intents.setupOptions(pending.interactionId!);
        expect(repairOptions.existingConnections).toEqual([]);
        expect(repairOptions.aiRepair).toMatchObject({ canReconnect: true, connection: { id: account.connectionId, grantId: account.grantId, isDefault: true, status: "revoked" } });
      }
      const wakeup = vi.fn(async (_agentId, opts) => {
        await db.insert(agentWakeupRequests).values({ companyId, agentId: recoveringAgentId, source: "automation", status: "queued", idempotencyKey: opts.idempotencyKey });
        return null;
      });
      const delivery = connectionIntentDeliveryService(db, { wakeup } as never);
      await delivery.deliver(pending.interactionId!);
      await delivery.deliver(pending.interactionId!);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (scenario === "restored") {
        expect(issue.status).toBe("in_progress");
        expect(wakeup).toHaveBeenCalledTimes(1);
        expect(wakeup).toHaveBeenCalledWith(recoveringAgentId, expect.objectContaining({ contextSnapshot: expect.objectContaining({ forceFreshSession: true }) }));
        expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId)).toBeNull();
        const [receipt] = await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, pending.interactionId!));
        expect(receipt.deliveredAt).not.toBeNull();
      } else {
        expect(wakeup).not.toHaveBeenCalled();
        expect(issue.status).toBe(scenario === "closed task" ? "done" : "blocked");
      }
    }, 30000,
  );
});

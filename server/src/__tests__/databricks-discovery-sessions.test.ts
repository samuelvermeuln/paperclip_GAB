import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { createDb, companies, companyMemberships, databricksDiscoverySessions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { errorHandler } from "../middleware/index.js";

/**
 * Route + service integration coverage for the Databricks catalog/schema/combo
 * discovery draft (`paperclip-databricks-descoberta-automatica.md` section 4/9,
 * task T04/T09): create → list catalogs/schemas/combos → save, plus the
 * lifecycle guarantees (ownership isolation, expiry, cancel, no credential
 * leakage, and "a failed save never loses the draft").
 */

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const FIXTURE_SECRET = "dbx-secret-SENTINEL-do-not-leak";

const databricksTokenResponse = () =>
  new Response(JSON.stringify({ access_token: "fixture-access-token", expires_in: 3600 }), { status: 200 });

/** Routes every Databricks endpoint hit during discovery: OAuth token, catalogs,
 * schemas, and model-services, each independently overridable per test. */
function databricksFetchImpl(overrides: {
  catalogs?: (url: URL) => Response | Promise<Response>;
  schemas?: (url: URL) => Response | Promise<Response>;
  modelServices?: (url: URL) => Response | Promise<Response>;
  token?: () => Response | Promise<Response>;
}) {
  return async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oidc/v1/token")) return (overrides.token ?? databricksTokenResponse)();
    if (url.pathname.endsWith("/unity-catalog/catalogs"))
      return (overrides.catalogs ?? (() => new Response(JSON.stringify({ catalogs: [] }), { status: 200 })))(url);
    if (url.pathname.endsWith("/unity-catalog/schemas"))
      return (overrides.schemas ?? (() => new Response(JSON.stringify({ schemas: [] }), { status: 200 })))(url);
    if (url.pathname.endsWith("/unity-catalog/model-services"))
      return (overrides.modelServices ?? (() => new Response(JSON.stringify({ model_services: [] }), { status: 200 })))(url);
    throw new Error(`Unexpected fetch to ${url.pathname}`);
  };
}

function buildApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId, otherCompanyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    };
    next();
  });
  app.use("/api", aiConnectionRoutes(db));
  app.use(errorHandler);
  return app;
}

async function createSession(userId = "alice", overrides: Parameters<typeof databricksFetchImpl>[0] = {}) {
  const app = buildApp(userId);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl(overrides));
  try {
    const res = await request(app)
      .post(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions`)
      .send({ workspaceHost: "https://acme.cloud.databricks.com", clientId: "dbx-client-id", clientSecret: FIXTURE_SECRET });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.discoverySessionId as string;
  } finally {
    fetchSpy.mockRestore();
  }
}

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-databricks-discovery-");
  db = createDb(database.connectionString);
  await db.insert(companies).values([
    { id: companyId, name: "Discovery tests", issuePrefix: "DDT" },
    { id: otherCompanyId, name: "Discovery tests (other)", issuePrefix: "DDO" },
  ]);
  await db.insert(companyMemberships).values([
    { companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "member" },
    { companyId, principalId: "eve", principalType: "user", status: "active", membershipRole: "member" },
    { companyId: otherCompanyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "member" },
  ]);
}, 90000);
afterAll(async () => {
  await database?.cleanup();
});

describe("POST /companies/:companyId/ai-connections/databricks/discovery-sessions", () => {
  it("authenticates and creates a draft without requiring catalog/schema, never returning the secret", async () => {
    const app = buildApp("alice");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl({}));
    try {
      const res = await request(app)
        .post(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions`)
        .send({ workspaceHost: "https://acme.cloud.databricks.com", clientId: "dbx-client-id", clientSecret: FIXTURE_SECRET });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.authStatus).toBe("authenticated");
      expect(res.body.discoverySessionId).toEqual(expect.any(String));
      expect(res.body.expiresAt).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain(FIXTURE_SECRET);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("classifies a rejected credential as DATABRICKS_AUTH_FAILED at the oauth stage, persisting nothing", async () => {
    const app = buildApp("alice");
    const before = await db.select().from(databricksDiscoverySessions).where(eq(databricksDiscoverySessions.companyId, companyId));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 401 }));
    try {
      const res = await request(app)
        .post(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions`)
        .send({ workspaceHost: "https://acme.cloud.databricks.com", clientId: "dbx-client-id", clientSecret: "wrong" });
      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({ code: "DATABRICKS_AUTH_FAILED", stage: "oauth", retryable: false });
      const after = await db.select().from(databricksDiscoverySessions).where(eq(databricksDiscoverySessions.companyId, companyId));
      expect(after).toHaveLength(before.length);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("Databricks discovery-session catalog/schema/combo listing", () => {
  it("paginates catalogs across an empty intermediate page, sorted with no duplicates", async () => {
    const pages = [
      new Response(JSON.stringify({ catalogs: [{ name: "main" }], next_page_token: "t1" }), { status: 200 }),
      new Response(JSON.stringify({ catalogs: [], next_page_token: "t2" }), { status: 200 }),
      new Response(JSON.stringify({ catalogs: [{ name: "system" }] }), { status: 200 }),
    ];
    let i = 0;
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl({ catalogs: () => pages[i++]! }));
    try {
      const res = await request(app).get(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/catalogs`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(["main", "system"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("scopes schemas to the requested catalog and requires the catalog query param", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      databricksFetchImpl({ schemas: () => new Response(JSON.stringify({ schemas: [{ name: "paperclip" }] }), { status: 200 }) }),
    );
    try {
      const missingCatalog = await request(app).get(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/schemas`);
      expect(missingCatalog.status).toBe(400);

      const res = await request(app).get(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/schemas?catalog=main`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items).toEqual([{ name: "paperclip", catalog: "main", fullName: "main.paperclip" }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lists combos (model services) scoped to catalog and schema", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      databricksFetchImpl({ modelServices: () => new Response(JSON.stringify({ model_services: [{ name: "model-services/main.paperclip.combo_ux" }] }), { status: 200 }) }),
    );
    try {
      const res = await request(app).get(
        `/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/model-services?catalog=main&schema=paperclip`,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items).toEqual([{ id: "main.paperclip.combo_ux", label: "Combo Ux" }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns 404 for a draft owned by a different user in the same company", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("eve");
    const res = await request(app).get(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/catalogs`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a draft addressed through a different company", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const res = await request(app).get(`/api/companies/${otherCompanyId}/ai-connections/databricks/discovery-sessions/${sessionId}/catalogs`);
    expect(res.status).toBe(404);
  });

  it("reports an expired draft as 410 DATABRICKS_DISCOVERY_EXPIRED and deletes it", async () => {
    const sessionId = await createSession("alice");
    await db.update(databricksDiscoverySessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(databricksDiscoverySessions.id, sessionId));
    const app = buildApp("alice");
    const res = await request(app).get(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/catalogs`);
    expect(res.status).toBe(410);
    expect(res.body.details).toMatchObject({ code: "DATABRICKS_DISCOVERY_EXPIRED", retryable: false });
    const rows = await db.select().from(databricksDiscoverySessions).where(eq(databricksDiscoverySessions.id, sessionId));
    expect(rows).toHaveLength(0);
  });

  it("cancels a draft so a later request reports it as gone", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const cancelRes = await request(app).delete(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}`);
    expect(cancelRes.status).toBe(200);
    const res = await request(app).get(`/api/companies/${companyId}/ai-connections/databricks/discovery-sessions/${sessionId}/catalogs`);
    expect(res.status).toBe(404);
  });
});

describe("POST /companies/:companyId/ai-connections with discoverySessionId", () => {
  it("saves a connection from a draft without resending the credential, then deletes the draft", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl({}));
    try {
      const res = await request(app)
        .post(`/api/companies/${companyId}/ai-connections`)
        .send({
          provider: "databricks",
          method: "oauth_m2m",
          name: "Saved from discovery",
          ownership: "personal",
          agentIds: [],
          allAgents: false,
          discoverySessionId: sessionId,
          catalog: "main",
          schema: "paperclip",
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.connectionId).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain(FIXTURE_SECRET);

      const rows = await db.select().from(databricksDiscoverySessions).where(eq(databricksDiscoverySessions.id, sessionId));
      expect(rows).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a create request that combines a discoverySessionId with a directly supplied credential", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const res = await request(app)
      .post(`/api/companies/${companyId}/ai-connections`)
      .send({
        provider: "databricks",
        method: "oauth_m2m",
        name: "Conflicting sources",
        ownership: "personal",
        agentIds: [],
        allAgents: false,
        discoverySessionId: sessionId,
        clientId: "dbx-client-id",
        clientSecret: "another-secret",
        catalog: "main",
        schema: "paperclip",
      });
    expect(res.status).toBe(400);
  });

  it("leaves the draft intact when the save-time re-validation fails, so the user can retry", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("alice");
    const rejectSave = vi.spyOn(globalThis, "fetch").mockImplementation(
      databricksFetchImpl({ modelServices: () => new Response(null, { status: 403 }) }),
    );
    try {
      const res = await request(app)
        .post(`/api/companies/${companyId}/ai-connections`)
        .send({
          provider: "databricks",
          method: "oauth_m2m",
          name: "Retry after failed save",
          ownership: "personal",
          agentIds: [],
          allAgents: false,
          discoverySessionId: sessionId,
          catalog: "main",
          schema: "paperclip",
        });
      expect(res.status).toBe(422);
    } finally {
      rejectSave.mockRestore();
    }
    const rows = await db.select().from(databricksDiscoverySessions).where(eq(databricksDiscoverySessions.id, sessionId));
    expect(rows).toHaveLength(1);

    // The user corrects nothing but retries — the same draft still works.
    const retryApp = buildApp("alice");
    const acceptSave = vi.spyOn(globalThis, "fetch").mockImplementation(databricksFetchImpl({}));
    try {
      const res = await request(retryApp)
        .post(`/api/companies/${companyId}/ai-connections`)
        .send({
          provider: "databricks",
          method: "oauth_m2m",
          name: "Retry after failed save",
          ownership: "personal",
          agentIds: [],
          allAgents: false,
          discoverySessionId: sessionId,
          catalog: "main",
          schema: "paperclip",
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    } finally {
      acceptSave.mockRestore();
    }
  });

  it("returns 404 when saving from a discovery session owned by a different user", async () => {
    const sessionId = await createSession("alice");
    const app = buildApp("eve");
    const res = await request(app)
      .post(`/api/companies/${companyId}/ai-connections`)
      .send({
        provider: "databricks",
        method: "oauth_m2m",
        name: "Not mine",
        ownership: "personal",
        agentIds: [],
        allAgents: false,
        discoverySessionId: sessionId,
        catalog: "main",
        schema: "paperclip",
      });
    expect(res.status).toBe(404);
  });
});

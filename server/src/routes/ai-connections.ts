import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
import { isDatabricksHostAllowed } from "../services/databricks-host-policy.js";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
import { localAiLoginService } from "../services/local-ai-login.js";
import { z } from "zod";
import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  adapterAuthSessions,
  heartbeatRuns,
  toolConnections,
  connectionGrants,
  agents,
} from "@paperclipai/db";
import {
  createAiConnectionSchema,
  aiConnectionLoginIntentSchema,
  localAiConnectionSchema,
  localAiLoginStartSchema,
  isAiConnectionCompatible,
  databricksDiscoverySessionCreateSchema,
  type AiConnectionLoginIntent,
  type AiProvider,
  type AiConnectionBinding,
  type DatabricksDiscoveryStage,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, gone, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { databricksDiscoverySessionService } from "../services/databricks-discovery-sessions.js";
import { validate } from "../middleware/validate.js";
import {
  validateDatabricksCredential,
  DatabricksDiscoveryError,
  type DatabricksModelServiceCredential,
} from "../services/databricks-model-services.js";
import type { DatabricksOAuthRequestContext } from "../services/databricks-oauth.js";

/** Agent API calls inherit authenticated run identity, never the agent's own ID. */
export function responsibleUserForAiRequest(req: Request): string | null {
  return req.actor.type === "agent"
    ? req.actor.onBehalfOfUserId ?? null
    : getActorInfo(req).actorId;
}

export async function assertAiConnectionCreateAccess(
  db: Db,
  req: Request,
  companyId: string,
  input: Pick<
    AiConnectionLoginIntent,
    "ownership" | "allAgents" | "agentIds" | "connectionId"
  >,
) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  const actor = getActorInfo(req);
  const userId = actor.actorId;
  if (input.connectionId) {
    const [grant] = await db
      .select({
        owner: connectionGrants.subjectUserId,
        creator: toolConnections.createdByUserId,
      })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        eq(toolConnections.id, connectionGrants.connectionId),
      )
      .where(
        and(
          eq(toolConnections.id, input.connectionId),
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.connectionPurpose, "ai"),
        ),
      )
      .limit(1);
    if (!grant || (grant.owner ?? grant.creator) !== userId)
      throw forbidden(
        "Only the account owner can reconnect this AI connection",
      );
  }
  const membership = req.actor.memberships?.find(
    (m) => m.companyId === companyId && m.status === "active",
  );
  const manager =
    req.actor.source === "local_implicit" ||
    req.actor.isInstanceAdmin ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin" ||
    (await accessService(db).hasPermission(
      companyId,
      "user",
      userId,
      "tools:manage_connections",
    ));
  if (
    !input.connectionId &&
    !manager &&
    (input.ownership === "shared" || input.allAgents)
  )
    throw forbidden(
      "A connection manager must authorize company-shared access",
    );
  if (!input.connectionId && !manager && input.agentIds.length) {
    for (const id of input.agentIds) {
      if (
        !(
          await accessService(db).decide({
            actor: { type: "board", userId },
            action: "agent_config:update",
            resource: { type: "agent", companyId, agentId: id },
          })
        ).allowed
      )
        throw forbidden("You cannot configure this agent");
    }
  }
  if (membership?.membershipRole === "viewer")
    throw forbidden("Viewers cannot create AI connections");
  return userId;
}

/** Creating an agent may install a shared connection only with the existing
 * connection-configure authority. An agent actor cannot grant itself access. */
export async function canInstallSharedAiConnectionForNewAgent(
  db: Db, req: Request, companyId: string, binding: AiConnectionBinding,
): Promise<boolean> {
  if (req.actor.type !== "board" || binding.mode !== "shared") return false;
  assertCompanyAccess(req, companyId);
  const member = req.actor.memberships?.find(m => m.companyId === companyId && m.status === "active");
  if (member?.membershipRole === "viewer") return false;
  const userId = getActorInfo(req).actorId;
  const [connection] = await db.select({ creator: toolConnections.createdByUserId })
    .from(toolConnections).where(and(eq(toolConnections.companyId, companyId),
      eq(toolConnections.id, binding.connectionId), eq(toolConnections.connectionPurpose, "ai")));
  if (!connection) return false;
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true ||
    connection.creator === userId || await accessService(db).hasPermission(companyId, "user", userId, "tools:manage_connections");
}

/** Fixed provider endpoints; credentials are never sent to a caller-supplied URL or through a redirect.
 * Databricks is validated separately via `validateDatabricksCredential` (it has no fixed
 * endpoint URL — the workspace host is caller-supplied per connection), so it is excluded here. */
export async function validateAiApiKey(
  provider: Exclude<AiProvider, "databricks">,
  key: string,
  request: typeof fetch = fetch,
) {
  const endpoints = {
    anthropic: "https://api.anthropic.com/v1/models?limit=1",
    openai: "https://api.openai.com/v1/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    xai: "https://api.x.ai/v1/models",
  };
  let response: Response;
  try {
    response = await request(endpoints[provider], {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers:
        provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key}` },
    });
  } catch {
    throw unprocessable("Could not verify the account. Try again.");
  }
  await response.body?.cancel();
  if (!response.ok)
    throw unprocessable(
      response.status === 401 || response.status === 403
        ? "The provider rejected this API key."
        : "The provider could not verify this account. Try again.",
    );
}

/** Requirement 1.4: on a SaaS deployment, reject a workspace host origin that is not on the
 * configured allowlist, unless private/self-hosted hosts have been explicitly enabled for this
 * deployment. Thrown before the live credential check so a disallowed host never reaches
 * Databricks. Non-SaaS deployments are unaffected. */
function assertDatabricksHostAllowed(
  workspaceHost: string,
  options: AiConnectionRouteOptions,
) {
  let origin: string;
  try {
    origin = new URL(workspaceHost).origin;
  } catch {
    throw unprocessable("The Databricks workspace host is invalid.");
  }
  if (
    !isDatabricksHostAllowed(origin, {
      deploymentMode: options.deploymentMode,
      deploymentExposure: options.deploymentExposure,
      allowPrivateHosts: options.allowPrivateDatabricksHosts,
      hostAllowlist: options.databricksHostAllowlist,
    })
  )
    throw unprocessable(
      "This workspace host is not on the configured allowlist for this deployment.",
    );
}

/** Validates a Databricks OAuth M2M credential (Client ID / Client secret) plus
 * workspace config live against Unity Catalog Model Services. Under the hood
 * `validateDatabricksCredential` performs a client-credentials token exchange and a
 * single Unity Catalog page — no static PAT is involved. Maps any
 * `DatabricksDiscoveryError` to the same `unprocessable(...)` error style the generic
 * provider path above uses; never lets a raw `DatabricksDiscoveryError` escape
 * uncaught, and never surfaces the client secret, the issued access token, or a
 * provider response body (all guarantees already hold in the underlying error).
 * `context` only correlates the OAuth token exchange with this request's own log
 * line — it never changes what is validated or thrown. */
async function validateDatabricksOAuthCredential(
  input: {
    clientId: string;
    clientSecret: string;
    workspaceHost?: string;
    catalog?: string;
    schema?: string;
    modelPrefix?: string;
  },
  context?: DatabricksOAuthRequestContext,
) {
  const credential: DatabricksModelServiceCredential = {
    host: input.workspaceHost!,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    catalog: input.catalog!,
    schema: input.schema!,
    modelPrefix: input.modelPrefix,
  };
  try {
    await validateDatabricksCredential(credential, context);
  } catch (error) {
    if (!(error instanceof DatabricksDiscoveryError)) throw error;
    if (error.kind === "invalid_host")
      throw unprocessable("The Databricks workspace host is invalid.");
    if (error.kind === "invalid_credential")
      throw unprocessable("Databricks rejected these Client ID / Client secret credentials.");
    if (error.kind === "scope_rejected")
      throw unprocessable("Databricks rejected the OAuth scope requested for these credentials.");
    if (error.kind === "insufficient_permission")
      throw unprocessable(
        "These Databricks credentials lack permission for the selected catalog and schema.",
      );
    if (error.kind === "upstream_rejected")
      throw unprocessable("Databricks rejected the request with an unexpected response. Try again.");
    throw unprocessable("Databricks could not verify these credentials. Try again.");
  }
}

/** Maps a `DatabricksDiscoveryError` raised anywhere in the discovery-session flow
 * (create, catalogs, schemas, model-services) to a classified HTTP error carrying
 * `{ code, stage, retryable }` (and `retryAfterSeconds` when Databricks sent
 * `Retry-After`) — see doc section 6. `error.retryable`, when the thrower set it
 * explicitly (e.g. a DNS/TLS cause that will not resolve by retrying, or an
 * unrecognized non-2xx response), overrides the kind's usual default — this
 * function never hardcodes every "unavailable"/"upstream_rejected" as
 * retryable. Never lets a raw `DatabricksDiscoveryError` escape uncaught, and
 * never surfaces a client secret, access token, or upstream response body. */
function mapDatabricksDiscoveryError(
  error: DatabricksDiscoveryError,
  stage: DatabricksDiscoveryStage,
): never {
  if (error.kind === "invalid_host")
    throw unprocessable(error.message, { code: "DATABRICKS_INVALID_INPUT", stage, retryable: false });
  if (error.kind === "invalid_credential")
    throw unprocessable(error.message, {
      code: stage === "oauth" ? "DATABRICKS_AUTH_FAILED" : "DATABRICKS_ACCESS_DENIED",
      stage,
      retryable: false,
    });
  if (error.kind === "scope_rejected")
    throw unprocessable(error.message, { code: "DATABRICKS_SCOPE_REJECTED", stage, retryable: false });
  if (error.kind === "insufficient_permission")
    throw unprocessable(error.message, { code: "DATABRICKS_ACCESS_DENIED", stage, retryable: false });
  if (error.kind === "rate_limited")
    throw tooManyRequests(error.message, {
      code: "DATABRICKS_RATE_LIMITED",
      stage,
      retryable: true,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  if (error.kind === "upstream_rejected")
    throw unprocessable(error.message, { code: "DATABRICKS_UPSTREAM_ERROR", stage, retryable: error.retryable ?? false });
  throw unprocessable(error.message, { code: "DATABRICKS_UPSTREAM_ERROR", stage, retryable: error.retryable ?? true });
}

/** Options for `aiConnectionRoutes`. Extends the local-AI-login policy options with the
 * Databricks host-allowlist policy inputs (Requirement 1.4), following the same
 * injectable-options style as `supportsLocalAiLogin` rather than reading env vars directly at
 * the route layer. */
export type AiConnectionRouteOptions = Parameters<typeof supportsLocalAiLogin>[0] & {
  allowPrivateDatabricksHosts?: boolean;
  databricksHostAllowlist?: ReadonlySet<string>;
};

export function aiConnectionRoutes(db: Db, options: AiConnectionRouteOptions = {}) {
  function assertLocalLoginAvailable() {
    if (!supportsLocalAiLogin(options)) throw unprocessable("Server-host subscription sign-in is unavailable on this hosted instance. Choose a supported sign-in environment or use an API key.");
  }
  const router = Router();
  const service = aiConnectionService(db);
  const localLogin = localAiLoginService(db);
  const discoverySessions = databricksDiscoverySessionService(db);
  /** A discovery draft needs the same authority as starting a create — an active,
   * non-viewer company member — but never the agent-authorization or reconnect-
   * ownership checks `assertAiConnectionCreateAccess` also does, since a draft names
   * no agent and no existing connection yet. */
  function assertDiscoverySessionAccess(req: Request, companyId: string): string {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const membership = req.actor.memberships?.find((m) => m.companyId === companyId && m.status === "active");
    if (membership?.membershipRole === "viewer") throw forbidden("Viewers cannot create AI connections");
    return getActorInfo(req).actorId;
  }
  function assertLocalOperator(req: Request) {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    if (req.actor.source !== "local_implicit")
      throw forbidden("Only the local operator can connect this machine's CLI account.");
  }
  // --- Databricks catalog/schema/combo discovery drafts -------------------
  // Base path per doc section 4: POST creates an authenticated draft from
  // Workspace URL + Client ID/Client secret alone; the GET endpoints below
  // page through that draft's catalogs/schemas/combos; DELETE cancels it.
  // None of these ever accept or return a client secret or access token.
  router.post(
    "/companies/:companyId/ai-connections/databricks/discovery-sessions",
    validate(databricksDiscoverySessionCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const input = databricksDiscoverySessionCreateSchema.parse(req.body);
      const userId = assertDiscoverySessionAccess(req, companyId);
      assertDatabricksHostAllowed(input.workspaceHost, options);
      try {
        res.setHeader("Cache-Control", "no-store");
        res.status(201).json(await discoverySessions.create(companyId, userId, input, { requestId: String(req.id) }));
      } catch (error) {
        if (error instanceof DatabricksDiscoveryError) mapDatabricksDiscoveryError(error, "oauth");
        throw error;
      }
    },
  );
  router.get(
    "/companies/:companyId/ai-connections/databricks/discovery-sessions/:id/catalogs",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = assertDiscoverySessionAccess(req, companyId);
      const sessionId = z.string().uuid().parse(req.params.id);
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      try {
        res.setHeader("Cache-Control", "no-store");
        res.json({ items: await discoverySessions.listCatalogs(companyId, userId, sessionId, { refresh }) });
      } catch (error) {
        if (error instanceof DatabricksDiscoveryError) mapDatabricksDiscoveryError(error, "catalogs");
        throw error;
      }
    },
  );
  router.get(
    "/companies/:companyId/ai-connections/databricks/discovery-sessions/:id/schemas",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = assertDiscoverySessionAccess(req, companyId);
      const sessionId = z.string().uuid().parse(req.params.id);
      const catalog = z.string().trim().min(1).max(128).parse(req.query.catalog);
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      try {
        res.setHeader("Cache-Control", "no-store");
        res.json({ items: await discoverySessions.listSchemas(companyId, userId, sessionId, catalog, { refresh }) });
      } catch (error) {
        if (error instanceof DatabricksDiscoveryError) mapDatabricksDiscoveryError(error, "schemas");
        throw error;
      }
    },
  );
  router.get(
    "/companies/:companyId/ai-connections/databricks/discovery-sessions/:id/model-services",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = assertDiscoverySessionAccess(req, companyId);
      const sessionId = z.string().uuid().parse(req.params.id);
      const catalog = z.string().trim().min(1).max(128).parse(req.query.catalog);
      const schema = z.string().trim().min(1).max(128).parse(req.query.schema);
      const modelPrefix = req.query.modelPrefix ? z.string().trim().min(1).max(128).parse(req.query.modelPrefix) : undefined;
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      try {
        res.setHeader("Cache-Control", "no-store");
        res.json({
          items: await discoverySessions.listModelServices(companyId, userId, sessionId, catalog, schema, modelPrefix, { refresh }),
        });
      } catch (error) {
        if (error instanceof DatabricksDiscoveryError) mapDatabricksDiscoveryError(error, "model_services");
        throw error;
      }
    },
  );
  router.delete(
    "/companies/:companyId/ai-connections/databricks/discovery-sessions/:id",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = assertDiscoverySessionAccess(req, companyId);
      const sessionId = z.string().uuid().parse(req.params.id);
      await discoverySessions.cancel(companyId, userId, sessionId);
      res.json({ ok: true });
    },
  );
  router.post("/companies/:companyId/ai-connections/local/attempts", validate(localAiLoginStartSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { restart, ...intent } = localAiLoginStartSchema.parse(req.body);
    assertLocalLoginAvailable();
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(await localLogin.start(companyId, userId, intent, restart));
  });
  router.post("/companies/:companyId/ai-connections/local/check", validate(localAiConnectionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { localSessionId, ...intent } = localAiConnectionSchema.parse(req.body);
    assertLocalLoginAvailable();
    // Only implicit local operators may inspect ambient Claude credentials.
    // Authenticated users sign in to their own company/user-scoped attempt.
    if (intent.provider === "anthropic" && !localSessionId) assertLocalOperator(req);
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.setHeader("Cache-Control", "no-store");
    res.json(await localLogin.check(companyId, userId, intent, localSessionId));
  });
  router.delete("/companies/:companyId/ai-connections/local/attempts/:sessionId", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    const id = z.string().uuid().parse(req.params.sessionId);
    await localLogin.cancel(req.params.companyId as string, getActorInfo(req).actorId, id);
    res.json({ ok: true });
  });
  router.get("/companies/:companyId/ai-connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const currentUserId = getActorInfo(req).actorId;
    res.setHeader("Cache-Control", "no-store");
    const agentId = req.query.agentId;
    if (agentId !== undefined && !z.string().uuid().safeParse(agentId).success)
      throw unprocessable("Invalid agent ID");
    res.json({
      currentUserId,
      connections: await service.list(
        companyId,
        currentUserId,
        agentId as string | undefined,
      ),
    });
  });
  router.get(
    "/companies/:companyId/ai-connections/:connectionId/active-runs",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      if (!z.string().uuid().safeParse(req.params.connectionId).success)
        throw unprocessable("Invalid connection ID");
      const [connection] = await db
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.id, req.params.connectionId as string),
            eq(toolConnections.connectionPurpose, "ai"),
          ),
        );
      if (!connection || !(await service.list(companyId, getActorInfo(req).actorId)).some(account => account.id === connection.id))
        throw notFound("AI connection not found");
      res.setHeader("Cache-Control", "no-store");
      res.json(
        await db
          .select({
            id: heartbeatRuns.id,
            agentId: agents.id,
            agentName: agents.name,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
              sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId' = ${connection.id}`,
            ),
          ),
      );
    },
  );
  router.post(
    "/companies/:companyId/ai-connections",
    validate(createAiConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const input = createAiConnectionSchema.parse(req.body);
      const userId = await assertAiConnectionCreateAccess(
        db,
        req,
        companyId,
        input,
      );
      const attemptStartedAt = new Date();
      if (input.provider === "databricks") {
        // Databricks authenticates with OAuth M2M (Client ID / Client secret),
        // not an api_key or the subscription sign-in flow. A `discoverySessionId`
        // resolves the already-authenticated Workspace URL / Client ID / Client
        // secret from its discovery draft instead of trusting a fresh copy on this
        // request — the shared schema's refinement already rejects a request that
        // sends both. Either way, enforce the SaaS host allowlist before any
        // network call, then verify the credential *and* the selected catalog/
        // schema live via a client-credentials token exchange plus a single Unity
        // Catalog page, so a stale or tampered selection can never be saved
        // silently. `save()` serializes the { clientId, clientSecret } pair itself
        // for databricks, so the positional credential argument is unused on this
        // path.
        const resolved = input.discoverySessionId
          ? await discoverySessions.resolveForSave(companyId, userId, input.discoverySessionId)
          : { workspaceHost: input.workspaceHost!, clientId: input.clientId!, clientSecret: input.clientSecret! };
        assertDatabricksHostAllowed(resolved.workspaceHost, options);
        await validateDatabricksOAuthCredential(
          {
            clientId: resolved.clientId,
            clientSecret: resolved.clientSecret,
            workspaceHost: resolved.workspaceHost,
            catalog: input.catalog,
            schema: input.schema,
            modelPrefix: input.modelPrefix,
          },
          { requestId: String(req.id), credentialSource: "request" },
        );
        const result = await service.save(
          companyId,
          userId,
          {
            ...input,
            workspaceHost: resolved.workspaceHost,
            clientId: resolved.clientId,
            clientSecret: resolved.clientSecret,
          },
          "",
          undefined,
          attemptStartedAt,
        );
        // The draft is only ever deleted after a confirmed save, so a failed
        // save above (thrown out of `validateDatabricksOAuthCredential` or
        // `service.save`) always leaves it intact for the user to retry.
        if (input.discoverySessionId) await discoverySessions.complete(input.discoverySessionId);
        res.status(201).json(result);
        return;
      }
      if (input.method !== "api_key")
        throw unprocessable(
          "Use the existing provider sign-in flow to connect a subscription",
        );
      await validateAiApiKey(input.provider, input.apiKey!);
      const result = await service.save(
        companyId,
        userId,
        input,
        input.apiKey!,
        undefined,
        attemptStartedAt,
      );
      res.status(201).json(result);
    },
  );
  router.post(
    "/companies/:companyId/ai-connections/local",
    validate(localAiConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const { localSessionId, ...input } = localAiConnectionSchema.parse(req.body);
      assertLocalLoginAvailable();
      if (input.provider === "anthropic" && !localSessionId) assertLocalOperator(req);
      const userId = await assertAiConnectionCreateAccess(db, req, companyId, input);
      if (localSessionId || input.provider === "openai" || input.provider === "xai") {
        if (!localSessionId) throw unprocessable("Start a separate local sign-in for this connection before connecting.");
        res.status(201).json(await localLogin.complete(companyId, userId, localSessionId, input));
        return;
      }
      const attemptStartedAt = new Date();
      const credential = await readVerifiedLocalAiCredential(input.provider);
      res.status(201).json(await service.save(companyId, userId, input, credential, undefined, attemptStartedAt));
    },
  );
  router.put(
    "/companies/:companyId/ai-connections/default",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const userId = getActorInfo(req).actorId;
      if (
        req.actor.memberships?.some(
          (m) => m.companyId === companyId && m.membershipRole === "viewer",
        )
      )
        throw forbidden("Viewers cannot change defaults");
      if (!z.string().uuid().safeParse(req.body.grantId).success)
        throw unprocessable("Choose a personal connection");
      await service.setDefault(companyId, userId, req.body.grantId);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "ai_connection.default_changed",
        entityType: "connection_grant",
        entityId: req.body.grantId,
      });
      res.json({ ok: true });
    },
  );
  router.get(
    "/companies/:companyId/ai-connections/login/:sessionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const [session] = await db
        .select({
          connectionId: adapterAuthSessions.connectionId,
          grantId: adapterAuthSessions.connectionGrantId,
        })
        .from(adapterAuthSessions)
        .where(
          and(
            eq(adapterAuthSessions.companyId, companyId),
            eq(adapterAuthSessions.startedByUserId, getActorInfo(req).actorId),
            eq(
              adapterAuthSessions.publicSessionId,
              req.params.sessionId as string,
            ),
          ),
        );
      if (!session?.connectionId)
        throw notFound("The login has not saved a connection");
      res.setHeader("Cache-Control", "no-store");
      res.json(session);
    },
  );
  return router;
}

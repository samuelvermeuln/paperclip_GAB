import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { databricksDiscoverySessions, type Db } from "@paperclipai/db";
import type {
  DatabricksCatalogOption,
  DatabricksSchemaOption,
  DatabricksDiscoveryStage,
  DatabricksDiscoverySessionStarted,
} from "@paperclipai/shared";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { gone, notFound } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { fetchDatabricksAccessToken } from "./databricks-oauth.js";
import {
  DatabricksDiscoveryError,
  invalidateDatabricksModelServiceCache,
  listDatabricksModelServices,
  type DatabricksDiscoveryKey,
} from "./databricks-model-services.js";
import {
  invalidateDatabricksCatalogDiscoveryCache,
  listDatabricksCatalogs,
  listDatabricksSchemas,
  type DatabricksHostCredential,
  type DatabricksHostDiscoveryKey,
} from "./databricks-catalog-discovery.js";

/**
 * Owns the short-lived Databricks discovery draft (Workspace URL + OAuth M2M
 * Client ID/Client secret, authenticated once, before any catalog/schema is
 * chosen). See `packages/db/src/schema/databricks_discovery_sessions.ts` for
 * the storage shape and its deletion guarantees.
 *
 * A draft is deleted outright on cancel, on expiry, and on a successful save
 * (`complete`) — never left behind in any of those three outcomes. A failed
 * save leaves the draft untouched so the user can correct catalog/schema and
 * retry without re-entering the credential.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;

function resolveTtlMs(): number {
  const raw = Number(process.env.PAPERCLIP_DATABRICKS_DISCOVERY_SESSION_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

export interface DatabricksDiscoverySessionCredential {
  workspaceHost: string;
  clientId: string;
  clientSecret: string;
}

function forgetSession(sessionId: string): void {
  invalidateDatabricksCatalogDiscoveryCache(sessionId);
  invalidateDatabricksModelServiceCache(sessionId);
}

export function databricksDiscoverySessionService(db: Db) {
  /** Best-effort sweep of every draft past its TTL. Safe to call repeatedly;
   * a draft is also re-checked for expiry on every read regardless. */
  async function reapExpired(): Promise<void> {
    const expired = await db
      .delete(databricksDiscoverySessions)
      .where(lte(databricksDiscoverySessions.expiresAt, new Date()))
      .returning({ id: databricksDiscoverySessions.id });
    for (const row of expired) forgetSession(row.id);
  }

  /**
   * Authenticates a Workspace URL / Client ID / Client secret live via the
   * OAuth M2M client-credentials exchange (throws `DatabricksDiscoveryError`
   * on failure, before anything is persisted), then stores the draft with the
   * client secret encrypted at rest. Never returns the secret or the issued
   * access token.
   */
  async function create(
    companyId: string,
    userId: string,
    input: { workspaceHost: string; clientId: string; clientSecret: string },
  ): Promise<DatabricksDiscoverySessionStarted> {
    await fetchDatabricksAccessToken({
      host: input.workspaceHost,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    const prepared = await localEncryptedProvider.createSecret({ value: input.clientSecret });
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + resolveTtlMs());
    await reapExpired();
    await db.insert(databricksDiscoverySessions).values({
      id,
      companyId,
      createdByUserId: userId,
      workspaceHost: input.workspaceHost,
      clientId: input.clientId,
      clientSecretMaterial: prepared.material,
      credentialVersion: randomUUID(),
      expiresAt,
    });
    return { discoverySessionId: id, expiresAt: expiresAt.toISOString(), authStatus: "authenticated" };
  }

  /** Loads a draft, enforcing company + creator ownership and TTL. A missing
   * or foreign-owned row reports the same generic 404 as any other resource a
   * caller cannot see; an expired row is deleted first, then reported as
   * `DATABRICKS_DISCOVERY_EXPIRED` so the UI can prompt a fresh reconnect. */
  async function get(companyId: string, userId: string, sessionId: string, stage: DatabricksDiscoveryStage) {
    const [row] = await db
      .select()
      .from(databricksDiscoverySessions)
      .where(
        and(
          eq(databricksDiscoverySessions.id, sessionId),
          eq(databricksDiscoverySessions.companyId, companyId),
        ),
      );
    if (!row || row.createdByUserId !== userId) throw notFound("Discovery session not found");
    if (row.expiresAt.getTime() <= Date.now()) {
      await db.delete(databricksDiscoverySessions).where(eq(databricksDiscoverySessions.id, sessionId));
      forgetSession(sessionId);
      throw gone("This discovery session has expired. Reconnect to continue.", {
        code: "DATABRICKS_DISCOVERY_EXPIRED",
        stage,
        retryable: false,
      });
    }
    return row;
  }

  async function resolveCredential(row: {
    workspaceHost: string;
    clientId: string;
    clientSecretMaterial: Record<string, unknown>;
  }): Promise<DatabricksHostCredential> {
    const clientSecret = await localEncryptedProvider.resolveVersion({
      material: row.clientSecretMaterial,
      externalRef: null,
    });
    return { host: row.workspaceHost, clientId: row.clientId, clientSecret };
  }

  function hostKey(row: { id: string; credentialVersion: string; workspaceHost: string }, companyId: string): DatabricksHostDiscoveryKey {
    return { companyId, connectionId: row.id, credentialVersion: row.credentialVersion, host: row.workspaceHost };
  }

  async function listCatalogs(
    companyId: string,
    userId: string,
    sessionId: string,
    options?: { refresh?: boolean },
  ): Promise<DatabricksCatalogOption[]> {
    const row = await get(companyId, userId, sessionId, "catalogs");
    const credential = await resolveCredential(row);
    return listDatabricksCatalogs(hostKey(row, companyId), credential, options);
  }

  async function listSchemas(
    companyId: string,
    userId: string,
    sessionId: string,
    catalog: string,
    options?: { refresh?: boolean },
  ): Promise<DatabricksSchemaOption[]> {
    const row = await get(companyId, userId, sessionId, "schemas");
    const credential = await resolveCredential(row);
    return listDatabricksSchemas(hostKey(row, companyId), credential, catalog, options);
  }

  async function listModelServices(
    companyId: string,
    userId: string,
    sessionId: string,
    catalog: string,
    schemaName: string,
    modelPrefix: string | undefined,
    options?: { refresh?: boolean },
  ): Promise<AdapterModel[]> {
    const row = await get(companyId, userId, sessionId, "model_services");
    const credential = await resolveCredential(row);
    const key: DatabricksDiscoveryKey = {
      companyId,
      connectionId: row.id,
      credentialVersion: row.credentialVersion,
      host: row.workspaceHost,
      catalog,
      schema: schemaName,
      modelPrefix,
    };
    return listDatabricksModelServices(key, { ...credential, catalog, schema: schemaName, modelPrefix }, options);
  }

  /** Resolves the draft's credential for the final save, without deleting the
   * draft — a failed save must leave it intact so the user can retry. Call
   * `complete` only after the save actually succeeds. */
  async function resolveForSave(
    companyId: string,
    userId: string,
    sessionId: string,
  ): Promise<DatabricksDiscoverySessionCredential> {
    const row = await get(companyId, userId, sessionId, "save");
    const credential = await resolveCredential(row);
    return { workspaceHost: row.workspaceHost, clientId: row.clientId, clientSecret: credential.clientSecret };
  }

  /** Deletes a draft after its credential has been transferred to a permanent
   * connection. Idempotent: a second call is a no-op. */
  async function complete(sessionId: string): Promise<void> {
    await db.delete(databricksDiscoverySessions).where(eq(databricksDiscoverySessions.id, sessionId));
    forgetSession(sessionId);
  }

  /** Cancels and discards a draft. Idempotent and silent on a draft that is
   * already gone (finished, expired, or never owned by this caller). */
  async function cancel(companyId: string, userId: string, sessionId: string): Promise<void> {
    await db
      .delete(databricksDiscoverySessions)
      .where(
        and(
          eq(databricksDiscoverySessions.id, sessionId),
          eq(databricksDiscoverySessions.companyId, companyId),
          eq(databricksDiscoverySessions.createdByUserId, userId),
        ),
      );
    forgetSession(sessionId);
  }

  return { create, listCatalogs, listSchemas, listModelServices, resolveForSave, complete, cancel, reapExpired };
}

export { DatabricksDiscoveryError };

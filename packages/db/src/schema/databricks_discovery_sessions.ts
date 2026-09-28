import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// The durable, short-lived draft created when a user authenticates a
// Databricks OAuth M2M credential (Client ID / Client secret) before choosing
// catalog/schema/combo. One row holds one draft. The credential is encrypted
// at rest (the same `local_encrypted` AES-256-GCM material used by
// `company_secrets`) and is never persisted anywhere else while the draft is
// open. The row is deleted outright on cancel, on expiry (reaped), and on a
// successful save that promotes the credential into the permanent secret
// store — it never lingers past any of those three outcomes.
//
// A Postgres-backed table (rather than an in-process `Map`) so the draft
// survives across replicas in a multi-instance deployment: any replica that
// receives a follow-up request for the same session can resolve it.
export const databricksDiscoverySessions = pgTable(
  "databricks_discovery_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // The only principal allowed to read/paginate/save this draft. Never a
    // credential in itself: every request must also present a valid Paperclip
    // session for this exact company + user.
    createdByUserId: text("created_by_user_id").notNull(),
    // Origin-only, https:// workspace host, already validated at create time.
    workspaceHost: text("workspace_host").notNull(),
    // The service-principal OAuth M2M client id. Not secret on its own, but
    // never returned to any other user's request.
    clientId: text("client_id").notNull(),
    // AES-256-GCM material from `local-encrypted-provider.ts`'s
    // `createSecret`/`resolveVersion` — the same scheme `company_secrets`
    // uses. Never the plaintext client secret.
    clientSecretMaterial: jsonb("client_secret_material").$type<Record<string, unknown>>().notNull(),
    // Bumped identity for this draft's credential, reused as the
    // `credentialVersion` part of the Databricks discovery cache key so a
    // draft's cached token/catalog/schema/combo lookups can never be confused
    // with another draft or a saved connection's cache entries.
    credentialVersion: text("credential_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // TTL enforced by the service on every read, and swept by a periodic
    // reaper; the reaper is best-effort and belt-and-suspenders only.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("databricks_discovery_sessions_company_user_idx").on(
      table.companyId,
      table.createdByUserId,
    ),
    expiresIdx: index("databricks_discovery_sessions_expires_idx").on(table.expiresAt),
  }),
);

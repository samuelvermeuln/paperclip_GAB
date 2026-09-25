import { z } from "zod";

/** Runtime authentication is a separate transport, never a tool or channel. */
export const connectionPurposeTransportSchema = z.discriminatedUnion(
  "connectionPurpose",
  [
    z.object({
      connectionPurpose: z.literal("tool"),
      transport: z.enum(["mcp_remote", "rest_api", "local_stdio"]),
    }),
    z.object({
      connectionPurpose: z.literal("channel"),
      transport: z.enum(["chat_sdk", "rest_api"]),
      config: z.object({ provider: z.string().optional() }).passthrough().optional(),
    }).refine(
      (connection) => connection.transport === "chat_sdk" || connection.config?.provider === "agentmail",
      { message: "REST channel connections require the AgentMail provider", path: ["config", "provider"] },
    ),
    z.object({
      connectionPurpose: z.literal("ai"),
      transport: z.literal("runtime_auth"),
    }),
  ],
);
export type ConnectionPurposeTransport = z.infer<
  typeof connectionPurposeTransportSchema
>;

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "xai",
  "databricks",
] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export const aiAuthMethodSchema = z.enum(["subscription", "api_key", "oauth_m2m"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiAuthMethod = z.infer<typeof aiAuthMethodSchema>;
const requirement = { provider: aiProviderSchema, method: aiAuthMethodSchema };
export const aiConnectionBindingSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: aiProviderSchema,
    // Retained on the wire for older servers during rolling upgrades. The
    // responsible user's provider default determines the actual run method.
    method: aiAuthMethodSchema,
    mode: z.literal("responsible_user"),
  }).strict(),
  z
    .object({
      ...requirement,
      mode: z.literal("shared"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requirement,
      // Legacy wire format only; human access still applies. New UI never creates it.
      mode: z.literal("delegated"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
]);
export type AiConnectionBinding = z.infer<typeof aiConnectionBindingSchema>;
export const aiConnectionMetadataSchema = z.object(requirement).strict();
export type AiConnectionMetadata = z.infer<typeof aiConnectionMetadataSchema>;

/** Existing integrations only. This table describes compatibility, never routing. */
export const AI_CONNECTION_CAPABILITIES: Record<
  AiProvider,
  {
    name: string;
    methods: Partial<
      Record<AiAuthMethod, { adapters: readonly string[]; envKey?: string }>
    >;
  }
> = {
  anthropic: {
    name: "Claude",
    methods: {
      subscription: {
        adapters: ["claude_local"],
        envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      api_key: { adapters: ["claude_local"], envKey: "ANTHROPIC_API_KEY" },
    },
  },
  openai: {
    name: "OpenAI",
    methods: {
      subscription: { adapters: ["codex_local"], envKey: "CODEX_HOME" },
      api_key: { adapters: ["codex_local"], envKey: "OPENAI_API_KEY" },
    },
  },
  openrouter: {
    name: "OpenRouter",
    methods: {
      api_key: { adapters: ["opencode_local"], envKey: "OPENROUTER_API_KEY" },
    },
  },
  xai: {
    name: "Grok",
    methods: {
      subscription: { adapters: ["grok_local"], envKey: "GROK_HOME" },
      api_key: { adapters: ["grok_local"], envKey: "XAI_API_KEY" },
    },
  },
  databricks: {
    name: "Databricks Unity Gateway",
    methods: {
      // No envKey: the credential is a (clientId, clientSecret) pair delivered
      // over a protected channel to the helper, never a single env var.
      oauth_m2m: { adapters: ["codex_local"] },
    },
  },
};
/** Origin-only, https-only workspace host: no userinfo, path, query, or fragment. */
const databricksWorkspaceHostSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().url().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const hasPath = url.pathname !== "" && url.pathname !== "/";
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      hasPath
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Workspace host must be an origin-only https:// URL without credentials, path, query, or fragment",
      });
    }
  }).transform((value) => new URL(value).origin),
);

/** Non-secret Databricks AI Connection settings, stored in the connection's `config` column. */
export const databricksConnectionConfigSchema = z.object({
  workspaceHost: databricksWorkspaceHostSchema,
  catalog: z.string().trim().min(1).max(128),
  schema: z.string().trim().min(1).max(128),
  modelPrefix: z.string().trim().min(1).max(128).optional(),
}).strict();
export type DatabricksConnectionConfig = z.infer<
  typeof databricksConnectionConfigSchema
>;

/**
 * OAuth 2.0 Machine-to-Machine (client credentials) pair for a Databricks
 * service principal. Persisted only in the encrypted secret store and never
 * serialized back to the client.
 */
export const databricksOAuthCredentialSchema = z.object({
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().trim().min(1).max(4096),
}).strict();
export type DatabricksOAuthCredential = z.infer<
  typeof databricksOAuthCredentialSchema
>;

export function isAiConnectionCompatible(
  requirement: AiConnectionMetadata | AiConnectionBinding,
  adapterType: string,
  model?: unknown,
  runnerProvider?: unknown,
  acpxAgent?: unknown,
): boolean {
  if (adapterType === "paperclip_runner")
    adapterType =
      runnerProvider === "claude" ||
      (runnerProvider === "acpx" && acpxAgent === "claude")
        ? "claude_local"
        : runnerProvider === "codex"
          ? "codex_local"
          : runnerProvider === "opencode"
            ? "opencode_local"
            : "unsupported";
  const methods = AI_CONNECTION_CAPABILITIES[requirement.provider].methods;
  const candidates = "mode" in requirement && requirement.mode === "responsible_user"
    ? Object.values(methods)
    : requirement.method ? [methods[requirement.method]] : [];
  return (
    candidates.some((method) => method?.adapters.includes(adapterType)) &&
    (requirement.provider !== "openrouter" ||
      (typeof model === "string" && model.startsWith("openrouter/")))
  );
}
export type AiConnectionUnavailableReason =
  | "responsible_user_missing"
  | "membership_missing"
  | "default_missing"
  | "connection_missing"
  | "connection_unavailable"
  | "incompatible"
  | "access_denied"
  | "credential_missing";
export interface AiConnectionAttribution {
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  mode: AiConnectionBinding["mode"];
  responsibleUserId: string | null;
}
export type AiConnectionResolution =
  | { ok: true; attribution: AiConnectionAttribution }
  | { ok: false; reason: AiConnectionUnavailableReason; message: string };

export interface AiManagedConnectionSummary {
  id: string;
  grantId: string;
  companyId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  name: string;
  accountLabel?: string;
  ownership: "personal" | "shared";
  ownerUserId?: string;
  ownerName?: string;
  isDefault: boolean;
  status: "connected" | "needs_attention" | "expired" | "revoked";
  unavailableReason?: string;
}
export const createAiConnectionSchema = z
  .object({
    ...requirement,
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    apiKey: z.string().trim().min(1).max(32768).optional(),
    loginSessionId: z.string().max(128).optional(),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
    // Databricks-specific connection configuration (see `databricksConnectionConfigSchema`).
    // Optional at the object level and required only for `provider: "databricks"` so every
    // other provider's payload shape stays unchanged.
    workspaceHost: databricksWorkspaceHostSchema.optional(),
    catalog: z.string().trim().min(1).max(128).optional(),
    schema: z.string().trim().min(1).max(128).optional(),
    modelPrefix: z.string().trim().min(1).max(128).optional(),
    // OAuth M2M credential pair — only used when provider === "databricks"
    // && method === "oauth_m2m". Optional at the object level so every other
    // provider's payload shape stays unchanged.
    clientId: z.string().trim().min(1).max(255).optional(),
    clientSecret: z.string().trim().min(1).max(4096).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!AI_CONNECTION_CAPABILITIES[v.provider].methods[v.method])
      ctx.addIssue({ code: "custom", message: "Unsupported sign-in method" });
    if (v.provider === "databricks") {
      // Databricks migrated from a static PAT (api_key) to OAuth M2M: it uses a
      // clientId/clientSecret pair, never apiKey/loginSessionId, so the generic
      // credential check below does not apply.
      if (v.method !== "oauth_m2m")
        ctx.addIssue({
          code: "custom",
          message: "Databricks connections only support the oauth_m2m sign-in method",
          path: ["method"],
        });
      if (!v.clientId)
        ctx.addIssue({ code: "custom", message: "Client ID is required", path: ["clientId"] });
      if (!v.clientSecret)
        ctx.addIssue({ code: "custom", message: "Client secret is required", path: ["clientSecret"] });
      if (!v.workspaceHost)
        ctx.addIssue({ code: "custom", message: "Workspace host is required", path: ["workspaceHost"] });
      if (!v.catalog)
        ctx.addIssue({ code: "custom", message: "Catalog is required", path: ["catalog"] });
      if (!v.schema)
        ctx.addIssue({ code: "custom", message: "Schema is required", path: ["schema"] });
      return;
    }
    if (
      v.method === "api_key"
        ? !v.apiKey || Boolean(v.loginSessionId)
        : !v.loginSessionId || Boolean(v.apiKey)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide exactly the credential for the selected sign-in method",
      });
    }
  });
export type CreateAiConnection = z.infer<typeof createAiConnectionSchema>;

export const aiConnectionLoginIntentSchema = z
  .object({
    provider: aiProviderSchema,
    method: z.literal("subscription"),
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict();
export type AiConnectionLoginIntent = z.infer<
  typeof aiConnectionLoginIntentSchema
>;

export const localAiConnectionSchema = aiConnectionLoginIntentSchema.extend({
  localSessionId: z.string().uuid().optional(),
});
export const localAiLoginStartSchema = aiConnectionLoginIntentSchema.extend({ restart: z.boolean().optional() });
export interface LocalAiLoginStatus {
  status: "ready" | "sign_in_required" | "expired";
}
export interface LocalAiLoginAttempt {
  sessionId: string;
  command: string;
  expiresAt: string;
}

/** Preview-era copies of rotating local credentials must be reconnected. */
export function aiSubscriptionNeedsIsolatedLogin(config: Record<string, unknown> | undefined): boolean {
  const metadata = aiConnectionMetadataSchema.safeParse(config?.ai);
  return metadata.success && metadata.data.method === "subscription" &&
    (metadata.data.provider === "openai" || metadata.data.provider === "xai") &&
    config?.aiIsolatedSubscription !== true;
}

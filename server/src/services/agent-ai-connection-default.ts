import {
  AI_PROVIDERS,
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiProvider,
} from "@paperclipai/shared";

// Only keys read by the child's provider express a child auth override.
// A config copied from another provider can retain unrelated keys.
const PROVIDER_AUTH_ENV_KEYS: Record<AiProvider, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL"],
  openrouter: ["OPENROUTER_API_KEY", "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "PAPERCLIP_OPENCODE_PROVIDERS"],
  xai: ["XAI_API_KEY", "GROK_API_KEY", "GROK_HOME", "XAI_BASE_URL"],
  databricks: ["DATABRICKS_TOKEN"],
};

/**
 * The order a hire falls back through when it cannot inherit its manager's
 * connection. Databricks Unity Gateway is this deployment's default model
 * source, so it is tried first; for `codex_local` it therefore wins over
 * OpenAI. Every other provider keeps its existing relative order.
 */
export const HIRE_PROVIDER_PREFERENCE: readonly AiProvider[] = [
  "databricks",
  ...AI_PROVIDERS.filter((provider) => provider !== "databricks"),
];

/**
 * The wire method a fallback binding carries. On a `responsible_user` binding
 * the method is wire-compat only — the responsible user's provider default
 * decides the real one — but it should still name a method the provider has.
 */
function fallbackMethodFor(provider: AiProvider): AiConnectionBinding["method"] {
  return provider === "databricks" ? "oauth_m2m" : "api_key";
}

/** A hire inherits a connection choice, never its manager's credentials or identity. */
export function defaultAiConnectionForHire(
  adapterType: string,
  config: Record<string, unknown>,
  managerBinding: unknown,
): AiConnectionBinding | undefined {
  const compatible = (binding: AiConnectionBinding) =>
    isAiConnectionCompatible(binding, adapterType, config.model, config.provider, config.acpxAgent);
  const inherited = aiConnectionBindingSchema.safeParse(managerBinding);
  // Unmanaged parents keep their existing login and credential-reference paths.
  if (!inherited.success) return undefined;
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  const childSetsAuthFor = (provider: AiProvider) =>
    PROVIDER_AUTH_ENV_KEYS[provider].some((key) => env[key] !== undefined);
  const withChildAuthPrecedence = (binding: AiConnectionBinding) =>
    childSetsAuthFor(binding.provider) ? undefined : binding;
  if (inherited.data.mode !== "delegated" && compatible(inherited.data)) {
    return withChildAuthPrecedence(inherited.data);
  }
  // The selected provider's personal default supplies the actual sign-in method
  // at run time. A provider without an account can be connected on the first task.
  const candidates = HIRE_PROVIDER_PREFERENCE
    .map((provider) => ({ provider, method: fallbackMethodFor(provider), mode: "responsible_user" }) as const)
    .filter((binding) => compatible(binding));
  // A child configured with its own credential for any provider its harness can
  // use keeps that credential. Preferring Databricks must not silently replace
  // an explicit OPENAI_API_KEY on a Codex hire, for example.
  if (candidates.some((binding) => childSetsAuthFor(binding.provider))) return undefined;
  return candidates[0];
}

/**
 * The model a Databricks hire should run, when it names none of its own.
 *
 * A Databricks Unity Gateway run needs a Unity Catalog combo as its model.
 * Left empty, Codex falls back to its own default model name, which the
 * gateway does not serve, so the child could never run. When the child
 * inherited its manager's Databricks connection verbatim, the manager's combo
 * lives in the same workspace and catalog and is the natural default. Returns
 * `undefined` whenever that is not exactly the situation.
 */
export function inheritedDatabricksComboModel(input: {
  adapterType: string;
  config: Record<string, unknown>;
  binding: unknown;
  managerAdapterType: string | null | undefined;
  managerConfig: Record<string, unknown> | null | undefined;
  managerBinding: unknown;
}): string | undefined {
  if (input.adapterType !== "codex_local" || input.managerAdapterType !== "codex_local") return undefined;
  if (typeof input.config.model === "string" && input.config.model.trim()) return undefined;
  const child = aiConnectionBindingSchema.safeParse(input.binding);
  const manager = aiConnectionBindingSchema.safeParse(input.managerBinding);
  if (!child.success || !manager.success) return undefined;
  if (child.data.provider !== "databricks" || manager.data.provider !== "databricks") return undefined;
  if (JSON.stringify(child.data) !== JSON.stringify(manager.data)) return undefined;
  const model = input.managerConfig?.model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

import { createHash } from "node:crypto";
import { HttpError, unprocessable } from "../errors.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { type Db, companySecrets, connectionGrants } from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  databricksConnectionConfigSchema,
  databricksOAuthCredentialSchema,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { secretService } from "./secrets.js";
import { decideCodexAuthMerge } from "@paperclipai/adapter-codex-local/server";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { decideGrokAuthMerge } from "@paperclipai/adapter-grok-local/server";

export function isAiConnectionBusy(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code === "ai_connection_busy";
}

// Blank values intentionally override inherited credentials in CLI child environments.
export const AI_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "DATABRICKS_TOKEN",
  "CODEX_HOME",
  "GROK_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_AUTH_JSON",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PAPERCLIP_OPENCODE_PROVIDERS",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "XAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;
export function stripAiAuthBindings(env: unknown): Record<string, unknown> {
  const result = {
    ...(env && typeof env === "object" ? (env as Record<string, unknown>) : {}),
  };
  for (const key of AI_AUTH_ENV_KEYS)
    if (
      ![
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "XAI_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "PAPERCLIP_OPENCODE_PROVIDERS",
      ].includes(key)
    )
      delete result[key];
  return result;
}
export async function assertManagedAiProjectAuth(
  config: Record<string, unknown>,
  provider: AiConnectionBinding["provider"],
  target?: AdapterExecutionTarget | null,
) {
  const extraArgs = [
    ...(Array.isArray(config.extraArgs) ? config.extraArgs : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ];
  if (
    extraArgs.some(
      (arg) =>
        typeof arg === "string" &&
        /^(--config|-c|--settings|--setting-sources|--api-key|--auth-token)(=|$)/.test(
          arg,
        ),
    )
  ) {
    throw unprocessable(
      "Remove authentication/configuration overrides before selecting a managed AI connection",
      { code: "ai_connection_incompatible" },
    );
  }
  const files =
    provider === "anthropic"
      ? [".claude/settings.json", ".claude/settings.local.json"]
      : provider === "openai"
        ? [".codex/config.toml"]
        : [];
  const pattern =
    "apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider[[:space:]]*=|env_key[[:space:]]*=|experimental_bearer_token|cli_auth_credentials_store";
  if (target?.kind === "remote" && files.length) {
    // Only inspect for conflicting keys; never return configuration or credential values.
    const result = await runAdapterExecutionTargetProcess(
      `ai-auth-check-${Date.now()}`,
      target,
      "sh",
      [
        "-c",
        `
directory=$1; pattern=$2; shift 2
while :; do
  for relative in "$@"; do
    file="$directory/$relative"
    if test -f "$file"; then
      grep -Eq "$pattern" "$file"
      result=$?
      if test "$result" -eq 0; then exit 42; fi
      if test "$result" -ne 1; then exit 43; fi
    fi
  done
  parent=$(dirname "$directory")
  if test "$parent" = "$directory"; then break; fi
  directory=$parent
done`,
        "ai-auth-check",
        target.remoteCwd,
        pattern,
        ...files,
      ],
      {
        cwd: target.remoteCwd,
        env: {},
        timeoutSec: 15,
        graceSec: 1,
        onLog: async () => {},
      },
    );
    if (result.exitCode !== 0)
      throw unprocessable(
        "The environment's project authentication settings must be checked before using this AI connection",
        { code: "ai_connection_incompatible" },
      );
    return;
  }
  let directory =
    typeof config.cwd === "string" ? path.resolve(config.cwd) : process.cwd();
  for (;;) {
    for (const relative of files) {
      try {
        const content = await readFile(path.join(directory, relative), "utf8");
        if (
          /apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider\s*=|env_key\s*=|experimental_bearer_token|cli_auth_credentials_store/.test(
            content,
          )
        ) {
          throw unprocessable(
            "Project authentication settings conflict with the selected AI connection",
            { code: "ai_connection_incompatible" },
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function managedAiHomeEnvironment(home: string): Record<string, string> {
  const providerHome = path.join(home, "provider");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: providerHome,
    GROK_HOME: providerHome,
    CLAUDE_CONFIG_DIR: providerHome,
  };
}

/** Only the server-created credential home is volatile; retain all other config. */
/** Name of the 0600 Databricks OAuth credential file written into the run's
 * ephemeral provider home; the OAuth helper reads it via
 * `DATABRICKS_CREDENTIAL_FILE`. */
const DATABRICKS_CREDENTIAL_FILE_NAME = "databricks-credential.json";

/** Absolute path of the run's Databricks credential file within a given
 * managed home, shared by the writer and the fingerprint stabilizer so the
 * two can never drift. */
function databricksCredentialFilePath(managedHome: string): string {
  return path.join(managedHome, "provider", DATABRICKS_CREDENTIAL_FILE_NAME);
}

export function managedAiSessionFingerprintConfig(
  config: Record<string, unknown>,
  managedHome: string | undefined,
): Record<string, unknown> {
  if (!managedHome) return config;
  const env = { ...(config.env as Record<string, unknown> | undefined) };
  const stable = managedAiHomeEnvironment("<managed-ai-home>");
  for (const [key, value] of Object.entries(managedAiHomeEnvironment(managedHome))) {
    if (env[key] === value) env[key] = stable[key];
  }
  // The Databricks OAuth credential file also lives under the volatile run
  // home. Neutralize its per-run path the same way as the managed-home keys
  // above, so an unchanged Databricks connection yields a stable session
  // fingerprint across runs instead of appearing to change every heartbeat.
  if (env.DATABRICKS_CREDENTIAL_FILE === databricksCredentialFilePath(managedHome))
    env.DATABRICKS_CREDENTIAL_FILE = databricksCredentialFilePath("<managed-ai-home>");
  return { ...config, env };
}

/** Bin name published by `@paperclipai/adapter-codex-local` (its package.json
 * `bin` entry, `./dist/server/databricks-oauth-token-cli.js`) for the OAuth
 * M2M `auth.command` helper. */
const DATABRICKS_OAUTH_TOKEN_BIN = "paperclip-databricks-oauth-token";
let cachedDatabricksHelperBinPath: string | undefined;

/**
 * Absolute path of the `paperclip-databricks-oauth-token` helper bin the run's
 * Codex process spawns as its `[model_providers.databricks.auth] command`.
 *
 * Resolved by walking up from this module to the `node_modules` that installs
 * `@paperclipai/adapter-codex-local` and pointing at the `node_modules/.bin`
 * shim npm/pnpm publish for that package's `bin` — the same ancestor-walk
 * convention the acpx engine (`findAncestorBin`) uses for the `codex-acp` bin,
 * so it works in both the monorepo dev layout and a packaged install. The
 * returned value is ALWAYS an absolute path and NEVER a bare command name: the
 * Codex process must not resolve the helper through its own PATH (design 5.6).
 */
function resolveDatabricksHelperBinPath(): string {
  if (cachedDatabricksHelperBinPath) return cachedDatabricksHelperBinPath;
  // On Windows npm/pnpm publish a `.cmd` shim next to the extension-less one.
  const shimNames =
    process.platform === "win32"
      ? [`${DATABRICKS_OAUTH_TOKEN_BIN}.cmd`, DATABRICKS_OAUTH_TOKEN_BIN]
      : [DATABRICKS_OAUTH_TOKEN_BIN];
  let current = path.dirname(fileURLToPath(import.meta.url));
  let installedBinDir: string | undefined;
  for (;;) {
    const nodeModules = path.join(current, "node_modules");
    const binDir = path.join(nodeModules, ".bin");
    // Prefer an existing shim: it is the cross-platform executable form.
    for (const name of shimNames) {
      const candidate = path.join(binDir, name);
      if (existsSync(candidate)) {
        cachedDatabricksHelperBinPath = candidate;
        return candidate;
      }
    }
    // Otherwise remember the first `node_modules` that actually installs the
    // adapter, so that even before `pnpm install` (re)generates the shim we
    // still return the absolute path where it will live rather than a
    // PATH-dependent bare name.
    if (
      !installedBinDir &&
      existsSync(
        path.join(nodeModules, "@paperclipai", "adapter-codex-local", "package.json"),
      )
    )
      installedBinDir = binDir;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (installedBinDir) {
    cachedDatabricksHelperBinPath = path.join(installedBinDir, shimNames[0]);
    return cachedDatabricksHelperBinPath;
  }
  throw new Error(
    `Unable to resolve the ${DATABRICKS_OAUTH_TOKEN_BIN} helper published by @paperclipai/adapter-codex-local`,
  );
}

export async function prepareManagedAiRuntime(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string | null;
    adapterType: string;
    binding: AiConnectionBinding;
    allowUninstalledPersonal?: boolean;
    allowUninstalledShared?: boolean;
    allowLegacyValidation?: boolean;
    config: Record<string, unknown>;
  },
) {
  const configuredEnv =
    input.config.env && typeof input.config.env === "object"
      ? (input.config.env as Record<string, unknown>)
      : {};
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "XAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "PAPERCLIP_OPENCODE_PROVIDERS",
  ]) {
    if (configuredEnv[key])
      throw unprocessable(
        "The configured provider routing is incompatible with this AI connection",
        { code: "ai_connection_incompatible" },
      );
  }
  await assertManagedAiProjectAuth(input.config, input.binding.provider);
  const service = aiConnectionService(db);
  let selection = await service.select({
    ...input,
    userId: input.responsibleUserId,
    model: input.config.model,
    runnerProvider: input.config.provider,
    acpxAgent: input.config.acpxAgent,
  });
  const subscriptionFile =
    selection.attribution.method === "subscription" &&
    input.binding.provider !== "anthropic";
  let home: string | undefined;
  try {
    const selectedGrantId = selection.grant.id;
    selection = await service.select({
      ...input,
      userId: input.responsibleUserId,
      model: input.config.model,
      runnerProvider: input.config.provider,
      acpxAgent: input.config.acpxAgent,
    });
    if (selection.grant.id !== selectedGrantId)
      throw unprocessable(
        "The selected default changed. Retry this execution.",
      );
    const value = await service.credential(selection);
    home = await mkdtemp(
      path.join(
        os.tmpdir(),
        `paperclip-ai-${input.companyId}-${selection.grant.id}-`,
      ),
    );
    const providerHome = path.join(home, "provider");
    await mkdir(providerHome, { mode: 0o700 });
    const env: Record<string, unknown> = {
      ...stripAiAuthBindings(input.config.env),
      ...Object.fromEntries(AI_AUTH_ENV_KEYS.map((key) => [key, ""])),
      ...managedAiHomeEnvironment(home),
    };
    const capability =
      AI_CONNECTION_CAPABILITIES[input.binding.provider].methods[
        selection.attribution.method
      ]!;
    const authFile = path.join(providerHome, "auth.json");
    if (input.binding.provider === "openai")
      await writeFile(
        path.join(providerHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
    if (subscriptionFile) await writeFile(authFile, value, { mode: 0o600 });
    // `capability.envKey` is optional: `oauth_m2m` (Databricks) has none, so
    // the resolved credential is never injected as an environment variable —
    // it is written to a protected file below instead (Property 3/8).
    else if (capability.envKey) env[capability.envKey] = value;
    if (
      input.binding.provider === "openai" &&
      selection.attribution.method === "api_key"
    ) {
      env.CODEX_API_KEY = value;
      await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: value }), {
        mode: 0o600,
      });
    }
    if (input.binding.provider === "openrouter") {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { openrouter: { options: { apiKey: value } } },
      });
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    }
    // Databricks: unlike the api_key/subscription providers above, the resolved
    // secret is never injected as an environment variable (there is no
    // `capability.envKey` for `oauth_m2m`). The value is a JSON
    // `{ clientId, clientSecret }` pair (design 6.2); the run's Codex process
    // authenticates through the external OAuth M2M helper, which reads the
    // credential from a 0600 file inside the ephemeral run home and never from
    // env/argv (Property 3/8). Alongside the credential file we attach a
    // per-run routing hint (workspace base URL, wire API, and the helper's
    // absolute command) so the codex_local adapter points Codex at the
    // workspace's Unity Gateway instead of OpenAI. The non-secret workspace
    // config is read from `selection.connection.config.databricks` (persisted
    // by `save()`), reusing the row already resolved by the `service.select()`
    // calls above so a second grant/audience/revocation resolution cannot
    // disagree with this one (e.g. if a grant is revoked between two calls).
    let providerRuntimeHint:
      | {
          provider: "databricks";
          baseUrl: string;
          wireApi: "responses";
          authCommand: string;
          authArgs: string[];
          authTimeoutMs: number;
          authRefreshIntervalMs: number;
        }
      | undefined;
    if (input.binding.provider === "databricks") {
      const databricksConfig = databricksConnectionConfigSchema.parse(
        (selection.connection.config as { databricks?: unknown }).databricks,
      );
      const { clientId, clientSecret } = databricksOAuthCredentialSchema.parse(
        JSON.parse(value),
      );
      // 0600 credential file inside the ephemeral run home. The OAuth helper
      // receives only its path (via `DATABRICKS_CREDENTIAL_FILE`), never the
      // secret itself. `writeFile` both creates the file and restricts it in
      // one call; a create/permission failure throws, which the outer `catch`
      // turns into an aborted preparation — no usable `config` is returned, so
      // the Codex process never starts. The file lives under `home`, so the
      // existing `rm(home, { recursive: true, force: true })` in `cleanup()`
      // removes it.
      const credentialFile = databricksCredentialFilePath(home);
      await writeFile(
        credentialFile,
        JSON.stringify({
          host: databricksConfig.workspaceHost,
          clientId,
          clientSecret,
        }),
        { mode: 0o600 },
      );
      env.DATABRICKS_CREDENTIAL_FILE = credentialFile;
      providerRuntimeHint = {
        provider: "databricks",
        baseUrl: `${databricksConfig.workspaceHost}/ai-gateway/codex/v1`,
        wireApi: "responses",
        authCommand: resolveDatabricksHelperBinPath(),
        authArgs: [],
        authTimeoutMs: 5_000,
        authRefreshIntervalMs: 1_800_000,
      };
    }
    const generation = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);
    const identity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${generation}`;
    return {
      config: {
        ...input.config,
        env,
        managedAiConnection: { ...selection.attribution, identity },
        // Nested inside `config` (not a sibling of it) so that every caller
        // which merges `managedAiRuntime.config` into its own run config
        // (e.g. heartbeat.ts's `Object.assign(resolvedConfig,
        // managedAiRuntime.config)`) automatically carries this forward to
        // `ctx.config` in the adapter's execute(), the same way
        // `managedAiConnection` already does. Contains no secret — only
        // `provider`/`baseUrl`/`wireApi` — so it is as safe to nest here as
        // `managedAiConnection` already is.
        ...(providerRuntimeHint ? { providerRuntimeHint } : {}),
      },
      attribution: selection.attribution,
      accountName: selection.connection.name,
      accountOwnerUserId: selection.grant.subjectUserId,
      identity,
      home,
      cleanup: async () => {
        try {
          if (subscriptionFile) {
            const refreshed = await readFile(authFile, "utf8");
            if (refreshed !== value)
              await db.transaction(async (tx) => {
                const [grant] = await tx
                  .select()
                  .from(connectionGrants)
                  .where(
                    and(
                      eq(connectionGrants.id, selection.grant.id),
                      eq(connectionGrants.companyId, input.companyId),
                    ),
                  )
                  .for("update");
                // A missing or revoked grant blocks the write-back. Among
                // active copies, the merge decision below keeps the
                // credential with the newest provider freshness field.
                if (!grant || grant.status !== "active") return;
                const ref = grant.credentialSecretRefs.find(
                  (r) => r.configPath === "ai.credential",
                );
                if (!ref) return;
                // Lock the referenced secret row for the rest of this
                // transaction. The grant-row lock above does not cover it,
                // so an authorized rotation of this secret could otherwise
                // land between the read and the write below and be
                // overwritten by this stale write-back.
                await tx
                  .select({ id: companySecrets.id })
                  .from(companySecrets)
                  .where(
                    and(
                      eq(companySecrets.id, ref.secretId),
                      eq(companySecrets.companyId, input.companyId),
                    ),
                  )
                  .for("update");
                const current = await aiConnectionService(
                  tx as unknown as Db,
                ).credential({ ...selection, grant });
                const destination = path.join(
                  providerHome,
                  "current-auth.json",
                );
                await writeFile(destination, current, { mode: 0o600 });
                const decision =
                  input.binding.provider === "openai"
                    ? await decideCodexAuthMerge(authFile, destination, {
                        errorLabel: "AI account refresh",
                      })
                    : await decideGrokAuthMerge(authFile, destination, {
                        errorLabel: "AI account refresh",
                      });
                if (decision !== 10) return;
                await secretService(tx).rotate(
                  ref.secretId,
                  { value: refreshed },
                  { userId: grant.subjectUserId },
                );
                await tx
                  .update(connectionGrants)
                  .set({ updatedAt: new Date() })
                  .where(eq(connectionGrants.id, grant.id));
              });
          }
        } finally {
          if (home) await rm(home, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (home) await rm(home, { recursive: true, force: true });
    throw error;
  }
}

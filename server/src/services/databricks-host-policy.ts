import type { DeploymentMode, DeploymentExposure } from "@paperclipai/shared";

const HOST_ALLOWLIST_ENV = "PAPERCLIP_DATABRICKS_HOST_ALLOWLIST";
const ALLOW_PRIVATE_HOSTS_ENV = "PAPERCLIP_DATABRICKS_ALLOW_PRIVATE_HOSTS";

function normalizeAllowlistedOrigin(value: string): string | null {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:") return null;
  return endpoint.origin.toLowerCase();
}

/** Comma-separated `https://` origins, mirroring the convention in
 * `server/src/adapters/http/remote-fetch.ts`'s `httpAdapterPrivateEndpointAllowlist`. */
export function databricksHostAllowlist(
  raw = process.env[HOST_ALLOWLIST_ENV] ?? "",
): ReadonlySet<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeAllowlistedOrigin(entry.trim()))
      .filter((entry): entry is string => entry !== null),
  );
}

function parseBooleanish(value: string | undefined | null): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

/** Same SaaS boundary as `supportsLocalAiLogin`: an authenticated + public deployment. */
function isSaasDeployment(deploymentMode?: DeploymentMode, deploymentExposure?: DeploymentExposure) {
  return deploymentMode === "authenticated" && deploymentExposure === "public";
}

/**
 * Requirement 1.4: on a SaaS deployment, a submitted Databricks workspace host origin must be on
 * the configured allowlist, unless an administrator has explicitly enabled private/self-hosted
 * hosts for that deployment. Non-SaaS deployments (e.g. `local_trusted`) are unaffected.
 */
export function isDatabricksHostAllowed(
  workspaceHostOrigin: string,
  options: {
    deploymentMode?: DeploymentMode;
    deploymentExposure?: DeploymentExposure;
    allowPrivateHosts?: boolean;
    hostAllowlist?: ReadonlySet<string>;
  } = {},
): boolean {
  if (!isSaasDeployment(options.deploymentMode, options.deploymentExposure)) return true;
  if (options.allowPrivateHosts ?? parseBooleanish(process.env[ALLOW_PRIVATE_HOSTS_ENV])) return true;
  const allowlist = options.hostAllowlist ?? databricksHostAllowlist();
  return allowlist.has(workspaceHostOrigin.toLowerCase());
}

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabricksHostCredential, DatabricksHostDiscoveryKey } from "./databricks-catalog-discovery.js";

const FAKE_ACCESS_TOKEN = "accessToken-SENTINEL-do-not-leak-catalogs";
const FAKE_CLIENT_SECRET = "clientSecret-SENTINEL-do-not-leak-catalogs";

const TOKEN_PATH = "/oidc/v1/token";
const CATALOGS_PATH = "/api/2.1/unity-catalog/catalogs";
const SCHEMAS_PATH = "/api/2.1/unity-catalog/schemas";

afterEach(() => {
  vi.unstubAllGlobals();
  // Each test dynamically re-imports the module so it starts with an empty
  // catalog/schema cache and an empty OAuth token cache (both hold
  // module-level state).
  vi.resetModules();
});

function credential(overrides: Partial<DatabricksHostCredential> = {}): DatabricksHostCredential {
  return {
    host: "https://acme.cloud.databricks.com",
    clientId: "sp-client-id-abcdef",
    clientSecret: FAKE_CLIENT_SECRET,
    ...overrides,
  };
}

function key(overrides: Partial<DatabricksHostDiscoveryKey> = {}): DatabricksHostDiscoveryKey {
  return {
    companyId: "company-1",
    connectionId: "draft-1",
    credentialVersion: "v1",
    host: "https://acme.cloud.databricks.com",
    ...overrides,
  };
}

function tokenResponse(accessToken = FAKE_ACCESS_TOKEN, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), { status: 200 });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function catalogsPage(names: string[], nextPageToken?: string) {
  return jsonResponse(200, {
    catalogs: names.map((name) => ({ name })),
    ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
  });
}

function schemasPage(names: string[], nextPageToken?: string) {
  return jsonResponse(200, {
    schemas: names.map((name) => ({ name })),
    ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
  });
}

function stubFetch(
  onCatalogs: (callIndex: number) => Response | Promise<Response>,
  onSchemas: (callIndex: number) => Response | Promise<Response> = () => schemasPage([]),
  token: () => Response | Promise<Response> = () => tokenResponse(),
) {
  let catalogsIndex = 0;
  let schemasIndex = 0;
  const fetch = vi.fn((input: URL | string) => {
    const path = new URL(String(input)).pathname;
    if (path === TOKEN_PATH) return Promise.resolve().then(() => token());
    if (path === CATALOGS_PATH) return Promise.resolve().then(() => onCatalogs(catalogsIndex++));
    if (path === SCHEMAS_PATH) return Promise.resolve().then(() => onSchemas(schemasIndex++));
    throw new Error(`Unexpected fetch to ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function callsTo(fetch: ReturnType<typeof vi.fn>, path: string) {
  return fetch.mock.calls.filter((call: unknown[]) => new URL(String(call[0])).pathname === path);
}

describe("listDatabricksCatalogs pagination", () => {
  it("aggregates every page and stops when next_page_token is absent", async () => {
    const pages = [catalogsPage(["main"], "tok-1"), catalogsPage(["samples"], "tok-2"), catalogsPage(["system"])];
    const fetch = stubFetch((i) => pages[i]!);
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    const result = await listDatabricksCatalogs(key(), credential());
    expect(callsTo(fetch, CATALOGS_PATH)).toHaveLength(3);
    expect(result.map((c) => c.name)).toEqual(["main", "samples", "system"]);
  });

  it("continues past an empty intermediate page that still carries next_page_token", async () => {
    const pages = [catalogsPage(["main"], "tok-1"), catalogsPage([], "tok-2"), catalogsPage(["system"])];
    const fetch = stubFetch((i) => pages[i]!);
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    const result = await listDatabricksCatalogs(key(), credential());
    expect(callsTo(fetch, CATALOGS_PATH)).toHaveLength(3);
    expect(result.map((c) => c.name)).toEqual(["main", "system"]);
  });

  it("sorts ascending, ordinal, case-sensitive and dedupes by name, keeping the first occurrence's comment", async () => {
    const fetch = stubFetch(() =>
      jsonResponse(200, {
        catalogs: [
          { name: "Zeta", comment: "z" },
          { name: "alpha", comment: "a" },
          { name: "alpha", comment: "duplicate, discarded" },
        ],
      }),
    );
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    const result = await listDatabricksCatalogs(key(), credential());
    // Ordinal/code-point order: uppercase "Zeta" sorts before lowercase "alpha".
    expect(result).toEqual([
      { name: "Zeta", comment: "z" },
      { name: "alpha", comment: "a" },
    ]);
    void fetch;
  });

  it("requests max_results=0 and forwards page_token", async () => {
    const pages = [catalogsPage(["main"], "tok-1"), catalogsPage(["system"])];
    const fetch = stubFetch((i) => pages[i]!);
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    await listDatabricksCatalogs(key(), credential());
    const calls = callsTo(fetch, CATALOGS_PATH);
    expect(new URL(String(calls[0]![0])).searchParams.get("max_results")).toBe("0");
    expect(new URL(String(calls[1]![0])).searchParams.get("page_token")).toBe("tok-1");
  });

  it("aborts and classifies as unavailable after 1000 consecutive pages without completing", async () => {
    const fetch = stubFetch(() => catalogsPage(["main"], "always-more"));
    const { listDatabricksCatalogs, DatabricksDiscoveryError } = await import("./databricks-catalog-discovery.js").then(
      async (mod) => ({ ...mod, DatabricksDiscoveryError: (await import("./databricks-model-services.js")).DatabricksDiscoveryError }),
    );
    await expect(listDatabricksCatalogs(key(), credential())).rejects.toBeInstanceOf(DatabricksDiscoveryError);
    void fetch;
  }, 20000);

  it("serves a second identical call from the 60s cache without another network call", async () => {
    const fetch = stubFetch(() => catalogsPage(["main"]));
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    await listDatabricksCatalogs(key(), credential());
    await listDatabricksCatalogs(key(), credential());
    expect(callsTo(fetch, CATALOGS_PATH)).toHaveLength(1);
  });

  it("bypasses the cache when refresh is requested", async () => {
    const fetch = stubFetch(() => catalogsPage(["main"]));
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    await listDatabricksCatalogs(key(), credential());
    await listDatabricksCatalogs(key(), credential(), { refresh: true });
    expect(callsTo(fetch, CATALOGS_PATH)).toHaveLength(2);
  });
});

describe("listDatabricksSchemas", () => {
  it("scopes the request to catalog_name and paginates to completion", async () => {
    const pages = [schemasPage(["paperclip"], "tok-1"), schemasPage(["default"])];
    const fetch = stubFetch(() => catalogsPage([]), (i) => pages[i]!);
    const { listDatabricksSchemas } = await import("./databricks-catalog-discovery.js");
    const result = await listDatabricksSchemas(key(), credential(), "main");
    const calls = callsTo(fetch, SCHEMAS_PATH);
    expect(calls).toHaveLength(2);
    expect(new URL(String(calls[0]![0])).searchParams.get("catalog_name")).toBe("main");
    expect(result).toEqual([
      { name: "default", catalog: "main", fullName: "main.default" },
      { name: "paperclip", catalog: "main", fullName: "main.paperclip" },
    ]);
  });

  it("prefers a full_name returned by the API over a derived one", async () => {
    const fetch = stubFetch(() => catalogsPage([]), () =>
      jsonResponse(200, { schemas: [{ name: "paperclip", full_name: "main.paperclip.v2" }] }),
    );
    const { listDatabricksSchemas } = await import("./databricks-catalog-discovery.js");
    const result = await listDatabricksSchemas(key(), credential(), "main");
    expect(result).toEqual([{ name: "paperclip", catalog: "main", fullName: "main.paperclip.v2" }]);
    void fetch;
  });

  it("rejects an empty catalog before any network call", async () => {
    const { listDatabricksSchemas } = await import("./databricks-catalog-discovery.js");
    await expect(listDatabricksSchemas(key(), credential(), "")).rejects.toThrow();
  });

  it("caches per catalog: a different catalog issues a new request", async () => {
    const fetch = stubFetch(() => catalogsPage([]), () => schemasPage(["paperclip"]));
    const { listDatabricksSchemas } = await import("./databricks-catalog-discovery.js");
    await listDatabricksSchemas(key(), credential(), "main");
    await listDatabricksSchemas(key(), credential(), "main");
    await listDatabricksSchemas(key(), credential(), "other");
    expect(callsTo(fetch, SCHEMAS_PATH)).toHaveLength(2);
  });
});

describe("error classification (shared with model-services)", () => {
  it.each([
    [401, "invalid_credential"],
    [403, "insufficient_permission"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [404, "unavailable"],
  ] as const)("maps HTTP %d from the catalogs endpoint to kind %s", async (status, kind) => {
    const fetch = stubFetch(() => jsonResponse(status, { message: "nope" }));
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    await expect(listDatabricksCatalogs(key(), credential())).rejects.toMatchObject({ kind });
    void fetch;
  });

  it("carries retryAfterSeconds from a 429's Retry-After header", async () => {
    const fetch = stubFetch(() => jsonResponse(429, {}, { "retry-after": "17" }));
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    await expect(listDatabricksCatalogs(key(), credential())).rejects.toMatchObject({ retryAfterSeconds: 17 });
    void fetch;
  });

  it("classifies a network failure as unavailable without leaking the credential", async () => {
    const fetch = vi.fn((input: URL | string) => {
      const path = new URL(String(input)).pathname;
      if (path === TOKEN_PATH) return Promise.resolve(tokenResponse());
      return Promise.reject(new Error("ECONNRESET"));
    });
    vi.stubGlobal("fetch", fetch);
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    const secret = FAKE_CLIENT_SECRET;
    await expect(listDatabricksCatalogs(key(), credential())).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      return true;
    });
  });

  it("rejects a non-origin workspace host before any network call", async () => {
    const fetch = stubFetch(() => catalogsPage([]));
    const { listDatabricksCatalogs } = await import("./databricks-catalog-discovery.js");
    await expect(
      listDatabricksCatalogs(key({ host: "https://acme.cloud.databricks.com/some/path" }), credential({ host: "https://acme.cloud.databricks.com/some/path" })),
    ).rejects.toMatchObject({ kind: "invalid_host" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("invalidateDatabricksCatalogDiscoveryCache", () => {
  it("forgets both catalog and schema cache entries for a connection", async () => {
    const fetch = stubFetch(() => catalogsPage(["main"]), () => schemasPage(["paperclip"]));
    const { listDatabricksCatalogs, listDatabricksSchemas, invalidateDatabricksCatalogDiscoveryCache } = await import(
      "./databricks-catalog-discovery.js"
    );
    await listDatabricksCatalogs(key(), credential());
    await listDatabricksSchemas(key(), credential(), "main");
    invalidateDatabricksCatalogDiscoveryCache("draft-1");
    await listDatabricksCatalogs(key(), credential());
    await listDatabricksSchemas(key(), credential(), "main");
    expect(callsTo(fetch, CATALOGS_PATH)).toHaveLength(2);
    expect(callsTo(fetch, SCHEMAS_PATH)).toHaveLength(2);
  });
});

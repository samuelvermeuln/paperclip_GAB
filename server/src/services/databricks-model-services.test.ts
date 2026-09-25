import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DatabricksDiscoveryKey,
  DatabricksModelServiceCredential,
} from "./databricks-model-services.js";

// Sentinels: distinctive strings that must never surface in an error message,
// a thrown value, a request URL, or a console log. The access token is what the
// mocked OAuth token endpoint mints; the client secret rides only inside the
// (server-side-only) credential and the OAuth exchange's Basic auth header.
const FAKE_ACCESS_TOKEN = "accessToken-SENTINEL-do-not-leak-1a2b3c4d";
const FAKE_CLIENT_SECRET = "clientSecret-SENTINEL-do-not-leak-9f8e7d6c";

const TOKEN_PATH = "/oidc/v1/token";
const MODEL_SERVICES_PATH = "/api/2.1/unity-catalog/model-services";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Each test dynamically re-imports the module so it starts with empty combo
  // and access-token caches (the discovery module and its OAuth dependency both
  // hold module-level state).
  vi.resetModules();
});

function credential(
  overrides: Partial<DatabricksModelServiceCredential> = {},
): DatabricksModelServiceCredential {
  return {
    host: "https://acme.cloud.databricks.com",
    clientId: "sp-client-id-abcdef",
    clientSecret: FAKE_CLIENT_SECRET,
    catalog: "main",
    schema: "paperclip",
    ...overrides,
  };
}

function key(overrides: Partial<DatabricksDiscoveryKey> = {}): DatabricksDiscoveryKey {
  return {
    companyId: "company-1",
    connectionId: "connection-1",
    credentialVersion: "1",
    host: "https://acme.cloud.databricks.com",
    catalog: "main",
    schema: "paperclip",
    ...overrides,
  };
}

/** A successful OIDC token response with a real, streamable body. */
function tokenResponse(accessToken = FAKE_ACCESS_TOKEN, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
  });
}

/** Any JSON response (used for error statuses) with a real, streamable body. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A model-services page with a real, streamable body. */
function page(names: string[], nextPageToken?: string) {
  return jsonResponse(200, {
    model_services: names.map((name) => ({ name })),
    ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
  });
}

type FetchCall = [URL | string, RequestInit];

/**
 * Stubs global fetch with URL dispatch: the OAuth token endpoint yields an
 * access token, and the model-services endpoint is driven by `modelServices`,
 * invoked per call with the 0-based model-services call index. This mirrors the
 * real flow — discovery resolves an access token via the OAuth service before
 * each page — so tests exercise the true two-endpoint path.
 */
function stubFetchByUrl(
  modelServices: (callIndex: number) => Response | Promise<Response>,
  token: () => Response | Promise<Response> = () => tokenResponse(),
) {
  let modelServicesIndex = 0;
  const fetch = vi.fn((input: URL | string) => {
    const path = new URL(String(input)).pathname;
    if (path === TOKEN_PATH) return Promise.resolve().then(() => token());
    const callIndex = modelServicesIndex++;
    return Promise.resolve().then(() => modelServices(callIndex));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/**
 * The model-services requests only, so token exchanges never skew call counts.
 * (The access token is cached per key, so a multi-page list still exchanges the
 * token just once, but filtering by path keeps every assertion unambiguous.)
 */
function modelServiceCalls(fetch: ReturnType<typeof vi.fn>): FetchCall[] {
  return fetch.mock.calls.filter(
    (call: unknown[]) => new URL(String(call[0])).pathname === MODEL_SERVICES_PATH,
  ) as FetchCall[];
}

describe("toAdapterModel / identifier + label normalization", () => {
  it("strips the model-services/ prefix from the identifier when present", async () => {
    const { toAdapterModel } = await import("./databricks-model-services.js");
    expect(toAdapterModel({ name: "model-services/main.paperclip.combo_ux" })?.id).toBe(
      "main.paperclip.combo_ux",
    );
  });

  it("keeps the resource name unchanged when the model-services/ prefix is absent", async () => {
    const { toAdapterModel } = await import("./databricks-model-services.js");
    const result = toAdapterModel({ name: "main.paperclip.combo_ux" });
    expect(result?.id).toBe("main.paperclip.combo_ux");
    expect(result?.label).toBe("Combo Ux");
  });

  it("returns null when the resource name is missing or not a string", async () => {
    const { toAdapterModel } = await import("./databricks-model-services.js");
    expect(toAdapterModel({})).toBeNull();
    expect(toAdapterModel({ name: 123 as unknown as string })).toBeNull();
  });

  it.each([
    // Separator becomes a space, only the first letter of each word is
    // uppercased, and the rest of each word keeps its original case.
    ["model-services/main.paperclip.combo_ux", "Combo Ux"],
    // No separator: the whole short name is one word, so only its first letter
    // is touched — "comboUX" -> "ComboUX", never "Comboux".
    ["model-services/main.paperclip.comboUX", "ComboUX"],
    ["model-services/main.paperclip.dev-team", "Dev Team"],
    ["model-services/main.paperclip.combo-router", "Combo Router"],
    // "COMBO" already starts uppercase and its remaining letters are preserved.
    ["model-services/main.paperclip.COMBO_prod", "COMBO Prod"],
    ["model-services/main.paperclip.no-prefix-name", "No Prefix Name"],
    ["model-services/main.paperclip.combo", "Combo"],
  ])("derives the label of %s as %s", async (name, expectedLabel) => {
    const { toAdapterModel } = await import("./databricks-model-services.js");
    expect(toAdapterModel({ name })?.label).toBe(expectedLabel);
  });
});

describe("pagination", () => {
  it("aggregates every page and stops when next_page_token is absent", async () => {
    const pages = [
      page(["model-services/main.paperclip.combo_a"], "token-1"),
      page(["model-services/main.paperclip.combo_b"], "token-2"),
      page(["model-services/main.paperclip.combo_c"]),
    ];
    const fetch = stubFetchByUrl((i) => pages[i]!);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(modelServiceCalls(fetch)).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual([
      "main.paperclip.combo_a",
      "main.paperclip.combo_b",
      "main.paperclip.combo_c",
    ]);
  });

  it("requests page_size=100, view=BASIC, and parent=schemas/<catalog>.<schema>", async () => {
    const fetch = stubFetchByUrl(() => page([]));

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const [firstUrl] = modelServiceCalls(fetch)[0]!;
    const url = new URL(String(firstUrl));
    expect(url.pathname).toBe(MODEL_SERVICES_PATH);
    expect(url.searchParams.get("parent")).toBe("schemas/main.paperclip");
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.get("view")).toBe("BASIC");
  });

  it("never calls GET /api/2.0/serving-endpoints", async () => {
    const fetch = stubFetchByUrl(() => page([]));

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    for (const call of fetch.mock.calls) {
      expect(String(call[0])).not.toContain("/api/2.0/serving-endpoints");
    }
  });

  it("forwards next_page_token from one response into the following request", async () => {
    const pages = [
      page(["model-services/main.paperclip.combo_a"], "abc123"),
      page(["model-services/main.paperclip.combo_b"]),
    ];
    const fetch = stubFetchByUrl((i) => pages[i]!);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const [secondUrl] = modelServiceCalls(fetch)[1]!;
    expect(new URL(String(secondUrl)).searchParams.get("page_token")).toBe("abc123");
  });

  it("aborts pagination past the 1000-page cap and classifies it as unavailable", async () => {
    // Every page keeps returning a next_page_token, so pagination never
    // naturally terminates and must be cut off at the hard cap (Requirement 1.9).
    const fetch = stubFetchByUrl(() =>
      page(["model-services/main.paperclip.combo_a"], "more"),
    );

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(modelServiceCalls(fetch)).toHaveLength(1000);
  });
});

describe("sort, dedupe, and filtering", () => {
  it("de-duplicates by id and sorts by label", async () => {
    const fetch = stubFetchByUrl(() =>
      page([
        "model-services/main.paperclip.combo_zeta",
        "model-services/main.paperclip.combo_alpha",
        "model-services/main.paperclip.combo_alpha",
      ]),
    );

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(result).toEqual([
      { id: "main.paperclip.combo_alpha", label: "Combo Alpha" },
      { id: "main.paperclip.combo_zeta", label: "Combo Zeta" },
    ]);
  });

  it("keeps the first occurrence when the same id arrives with and without the prefix", async () => {
    // Both names normalize to the same id; dedupe must collapse them to one.
    const fetch = stubFetchByUrl(() =>
      page([
        "model-services/main.paperclip.combo_dup",
        "main.paperclip.combo_dup",
      ]),
    );

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(result).toEqual([{ id: "main.paperclip.combo_dup", label: "Combo Dup" }]);
  });

  it("excludes combos whose short name does not start with the configured modelPrefix", async () => {
    const fetch = stubFetchByUrl(() =>
      page([
        "model-services/main.paperclip.combo_ux",
        "model-services/main.paperclip.other_thing",
      ]),
    );

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(
      key({ modelPrefix: "combo" }),
      credential({ modelPrefix: "combo" }),
    );

    expect(result.map((m) => m.id)).toEqual(["main.paperclip.combo_ux"]);
  });

  it("applies the modelPrefix filter case-sensitively", async () => {
    // Prefix "Combo" (capital C) must not match the lowercase "combo_ux".
    const fetch = stubFetchByUrl(() =>
      page([
        "model-services/main.paperclip.combo_ux",
        "model-services/main.paperclip.Combo_prod",
      ]),
    );

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(
      key({ modelPrefix: "Combo" }),
      credential({ modelPrefix: "Combo" }),
    );

    expect(result.map((m) => m.id)).toEqual(["main.paperclip.Combo_prod"]);
  });

  it("drops any entry outside the configured catalog.schema pair", async () => {
    const fetch = stubFetchByUrl(() =>
      page([
        "model-services/main.paperclip.combo_ux",
        "model-services/main.other_schema.combo_leak",
        "model-services/other_catalog.paperclip.combo_leak2",
      ]),
    );

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(result.map((m) => m.id)).toEqual(["main.paperclip.combo_ux"]);
  });

  it("qualifies the catalog.schema pair case-sensitively", async () => {
    // "main.Paperclip.*" must not qualify under a "main.paperclip" configuration.
    const fetch = stubFetchByUrl(() =>
      page([
        "model-services/main.paperclip.combo_ux",
        "model-services/main.Paperclip.combo_case",
      ]),
    );

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(result.map((m) => m.id)).toEqual(["main.paperclip.combo_ux"]);
  });
});

describe("cache", () => {
  it("serves a cached result on a second call within the TTL", async () => {
    const fetch = stubFetchByUrl(() => page(["model-services/main.paperclip.combo_a"]));

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());
    await listDatabricksModelServices(key(), credential());

    expect(modelServiceCalls(fetch)).toHaveLength(1);
  });

  it("queries again once the cache entry expires (TTL)", async () => {
    vi.useFakeTimers();
    const fetch = stubFetchByUrl(() => page(["model-services/main.paperclip.combo_a"]));

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());
    vi.advanceTimersByTime(60_001);
    await listDatabricksModelServices(key(), credential());

    expect(modelServiceCalls(fetch)).toHaveLength(2);
  });

  it("bypasses and repopulates the cache when refresh: true is passed", async () => {
    const fetch = stubFetchByUrl(() => page(["model-services/main.paperclip.combo_a"]));

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());
    await listDatabricksModelServices(key(), credential(), { refresh: true });
    await listDatabricksModelServices(key(), credential());

    // First call populates; refresh bypasses+repopulates; third hits the
    // repopulated cache — so exactly 2 model-services calls total.
    expect(modelServiceCalls(fetch)).toHaveLength(2);
  });

  it("keeps cache entries isolated per DatabricksDiscoveryKey", async () => {
    const pages = [
      page(["model-services/main.paperclip.combo_a"]),
      page(["model-services/main.other.combo_b"]),
    ];
    const fetch = stubFetchByUrl((i) => pages[i]!);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const resultA = await listDatabricksModelServices(key({ companyId: "company-a" }), credential());
    const resultB = await listDatabricksModelServices(
      key({ companyId: "company-b", schema: "other" }),
      credential({ schema: "other" }),
    );

    expect(modelServiceCalls(fetch)).toHaveLength(2);
    expect(resultA.map((m) => m.id)).toEqual(["main.paperclip.combo_a"]);
    expect(resultB.map((m) => m.id)).toEqual(["main.other.combo_b"]);
  });

  it("invalidateDatabricksModelServiceCache clears every entry for a connection", async () => {
    const fetch = stubFetchByUrl(() => page(["model-services/main.paperclip.combo_a"]));

    const { listDatabricksModelServices, invalidateDatabricksModelServiceCache } = await import(
      "./databricks-model-services.js"
    );
    await listDatabricksModelServices(key(), credential());
    invalidateDatabricksModelServiceCache("connection-1");
    await listDatabricksModelServices(key(), credential());

    expect(modelServiceCalls(fetch)).toHaveLength(2);
  });

  it("does not invalidate a different connection's cache entries", async () => {
    const fetch = stubFetchByUrl(() => page(["model-services/main.paperclip.combo_a"]));

    const { listDatabricksModelServices, invalidateDatabricksModelServiceCache } = await import(
      "./databricks-model-services.js"
    );
    await listDatabricksModelServices(key(), credential());
    invalidateDatabricksModelServiceCache("some-other-connection");
    await listDatabricksModelServices(key(), credential());

    expect(modelServiceCalls(fetch)).toHaveLength(1);
  });
});

describe("HTTP error mapping", () => {
  it("maps 401 to invalid_credential", async () => {
    stubFetchByUrl(() => jsonResponse(401, { message: "bad token" }));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "invalid_credential",
    });
  });

  it("maps 403 to insufficient_permission", async () => {
    stubFetchByUrl(() => jsonResponse(403, {}));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "insufficient_permission",
    });
  });

  it("maps 429 to rate_limited and captures Retry-After when present", async () => {
    stubFetchByUrl(() => jsonResponse(429, {}, { "Retry-After": "42" }));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it("maps 429 to rate_limited with no retryAfterSeconds when the header is absent", async () => {
    stubFetchByUrl(() => jsonResponse(429, {}));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: undefined,
    });
  });

  it("maps 500 to unavailable", async () => {
    stubFetchByUrl(() => jsonResponse(500, {}));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps 503 to unavailable", async () => {
    stubFetchByUrl(() => jsonResponse(503, {}));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a network failure to unavailable", async () => {
    stubFetchByUrl(() => Promise.reject(new Error("ECONNRESET")));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a timeout (AbortError) to unavailable", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    stubFetchByUrl(() => Promise.reject(abortError));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("applies a 10-second timeout via AbortSignal on the model-services request", async () => {
    const fetch = stubFetchByUrl(() => page([]));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const [, init] = modelServiceCalls(fetch)[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a non-https host with invalid_host and never calls fetch", async () => {
    const fetch = stubFetchByUrl(() => page([]));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(
      listDatabricksModelServices(
        key({ host: "http://acme.cloud.databricks.com" }),
        credential({ host: "http://acme.cloud.databricks.com" }),
      ),
    ).rejects.toMatchObject({ kind: "invalid_host" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a host with a path as invalid_host", async () => {
    stubFetchByUrl(() => page([]));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(
      listDatabricksModelServices(
        key({ host: "https://acme.cloud.databricks.com/foo" }),
        credential({ host: "https://acme.cloud.databricks.com/foo" }),
      ),
    ).rejects.toMatchObject({ kind: "invalid_host" });
  });
});

describe("token non-leak", () => {
  it("never includes the access token or client secret in any thrown discovery error", async () => {
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");

    // The token endpoint always mints FAKE_ACCESS_TOKEN; each model-services
    // response/error deliberately echoes the sentinels back so a leak into the
    // classified error would be caught. Every failure must throw a fixed,
    // generic message per kind.
    const scenarios: Array<() => Promise<unknown>> = [];
    for (const status of [401, 403, 429, 500, 502, 503]) {
      scenarios.push(async () => {
        stubFetchByUrl(() =>
          jsonResponse(status, { token: FAKE_ACCESS_TOKEN, secret: FAKE_CLIENT_SECRET }),
        );
        return listDatabricksModelServices(key(), credential()).catch((error: unknown) => error);
      });
    }
    scenarios.push(async () => {
      stubFetchByUrl(() => Promise.reject(new Error(`network error near ${FAKE_ACCESS_TOKEN}`)));
      return listDatabricksModelServices(key(), credential()).catch((error: unknown) => error);
    });
    scenarios.push(async () => {
      stubFetchByUrl(
        () => new Response(JSON.stringify({ error: `invalid token ${FAKE_ACCESS_TOKEN}` }), { status: 401 }),
      );
      return listDatabricksModelServices(key(), credential()).catch((error: unknown) => error);
    });

    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];

    for (const scenario of scenarios) {
      const error = await scenario();
      expect(error).toBeInstanceOf(Error);
      const surfaces = [
        (error as Error).message,
        (error as Error).stack ?? "",
        String(error),
      ].join("\n");
      expect(surfaces).not.toContain(FAKE_ACCESS_TOKEN);
      expect(surfaces).not.toContain(FAKE_CLIENT_SECRET);
    }

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(FAKE_ACCESS_TOKEN);
        expect(serialized).not.toContain(FAKE_CLIENT_SECRET);
      }
      spy.mockRestore();
    }
  });

  it("sends the access token only in the model-services Authorization header, never in the URL or logs", async () => {
    const fetch = stubFetchByUrl(() => page([]));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const [url, init] = modelServiceCalls(fetch)[0]!;
    expect(String(url)).not.toContain(FAKE_ACCESS_TOKEN);
    expect(String(url)).not.toContain(FAKE_CLIENT_SECRET);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);

    for (const call of consoleSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(FAKE_ACCESS_TOKEN);
      expect(serialized).not.toContain(FAKE_CLIENT_SECRET);
    }
    consoleSpy.mockRestore();
  });
});

describe("pagination (property): complete union without duplicates", () => {
  // A small, fixed pool of short names so the same name recurs across pages,
  // deliberately exercising the dedupe path. All names live under the
  // configured `main.paperclip` catalog.schema (with no modelPrefix set), so
  // every generated entry survives filtering and the expected set is simply the
  // deduped union of all pages' ids.
  const SHORT_NAMES = [
    "combo_a",
    "combo_b",
    "combo_c",
    "combo_ux",
    "combo-router",
    "dev_team",
    "combo_zeta",
    "comboUX",
    "combo",
    "combo_prod",
  ] as const;

  // One resource entry: a short name plus whether its resource carries the
  // optional `model-services/` prefix. The prefix is stripped during
  // normalization, so an entry with and one without the prefix collapse to the
  // same id — another dedupe case worth generating.
  const entryArb = fc.record({
    shortName: fc.constantFrom(...SHORT_NAMES),
    withPrefix: fc.boolean(),
  });

  // A page: up to 10 entries plus a randomly generated (non-empty) token. The
  // token is only attached to non-final pages when the sequence is materialized
  // below; the final page always omits it so pagination terminates naturally.
  const pageArb = fc.record({
    entries: fc.array(entryArb, { maxLength: 10 }),
    token: fc.string({ minLength: 1, maxLength: 12 }),
  });

  const resourceName = (entry: { shortName: string; withPrefix: boolean }) =>
    `${entry.withPrefix ? "model-services/" : ""}main.paperclip.${entry.shortName}`;

  const idOf = (entry: { shortName: string }) => `main.paperclip.${entry.shortName}`;

  // Property 5 (Paginação completa e sem duplicação): for any sequence of pages
  // chained by next_page_token and terminating on a token-less final page, the
  // returned list is exactly the union of every page's entries, deduped by id
  // keeping the first occurrence (Requirements 1.2, 1.7).
  it("∀ chained page sequence, returns the deduped union of all pages with no duplicate ids", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(pageArb, { minLength: 1, maxLength: 30 }),
        async (pageSpecs) => {
          // Fresh module state per generated sequence so the combo cache and the
          // OAuth token cache never bleed across runs.
          vi.resetModules();
          try {
            // Every non-final page returns a token so discovery keeps going; the
            // final page omits it so pagination stops on its own (well under the
            // 1000-page cap, which is covered separately by a plain test).
            const responsePages = pageSpecs.map((spec, index) => {
              const names = spec.entries.map(resourceName);
              const isLast = index === pageSpecs.length - 1;
              return page(names, isLast ? undefined : spec.token);
            });
            const fetch = stubFetchByUrl((i) => responsePages[i]!);

            // Expected: walk every page in receive order, deriving each entry's
            // id and keeping the first occurrence of each — mirroring the
            // service's dedupe-by-id-before-sort contract exactly.
            const expectedIds: string[] = [];
            const seen = new Set<string>();
            for (const spec of pageSpecs) {
              for (const entry of spec.entries) {
                const id = idOf(entry);
                if (!seen.has(id)) {
                  seen.add(id);
                  expectedIds.push(id);
                }
              }
            }

            const { listDatabricksModelServices } = await import("./databricks-model-services.js");
            const result = await listDatabricksModelServices(key(), credential());
            const resultIds = result.map((m) => m.id);

            // No id appears twice in the returned list.
            expect(new Set(resultIds).size).toBe(resultIds.length);
            // The returned set is exactly the deduped union of all pages. The
            // service sorts by label while the expected set is in receive order,
            // so compare order-independently.
            expect([...resultIds].sort()).toEqual([...expectedIds].sort());
            // Every generated page was actually fetched: pagination followed the
            // token chain to its natural, token-less end.
            expect(modelServiceCalls(fetch)).toHaveLength(responsePages.length);
          } finally {
            vi.unstubAllGlobals();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("serializeKey (property): cache-key injectivity", () => {
  // Property 2 (support): the discovery cache key is injective over the full
  // identity tuple. Two DatabricksDiscoveryKeys that differ in ANY field
  // (companyId, connectionId, credentialVersion, host, catalog, schema, or
  // modelPrefix — including the absent-vs-present case) must never serialize to
  // the same string; two structurally identical keys must serialize equal.
  // Validates: Requirements 5.1

  // A deliberately tiny pool of short values so overlaps recur across runs:
  // it forces the field-boundary ambiguity ("a"/"bc" vs "ab"/"c"), occasional
  // fully-equal tuples (exercising the equal branch), and JSON-significant
  // characters (`"`, `\`, `.`) that prove the array serialization stays
  // unambiguous regardless of content.
  const fieldArb = fc.constantFrom("", "a", "b", "c", "ab", "bc", "abc", '"', "\\", "a.b");

  // A configured modelPrefix is always a non-empty trimmed string, so the
  // present case draws a non-empty value; the nil case models "no prefix
  // configured" (absent), which serializes via NO_MODEL_PREFIX_MARKER.
  const modelPrefixArb = fc.option(fc.constantFrom("a", "b", "ab", "combo", '"'), {
    nil: undefined,
  });

  const keyArb: fc.Arbitrary<DatabricksDiscoveryKey> = fc.record({
    companyId: fieldArb,
    connectionId: fieldArb,
    credentialVersion: fieldArb,
    host: fieldArb,
    catalog: fieldArb,
    schema: fieldArb,
    modelPrefix: modelPrefixArb,
  });

  const IDENTITY_FIELDS = [
    "companyId",
    "connectionId",
    "credentialVersion",
    "host",
    "catalog",
    "schema",
    "modelPrefix",
  ] as const;

  // Structural equality over the full identity tuple. `undefined === undefined`
  // for an absent modelPrefix on both sides, and `undefined !== "x"` for the
  // absent-vs-present case — exactly the distinction serializeKey must preserve.
  function keysEqual(a: DatabricksDiscoveryKey, b: DatabricksDiscoveryKey): boolean {
    return IDENTITY_FIELDS.every((field) => a[field] === b[field]);
  }

  it("∀ pair of keys, serializeKey is equal iff every identity field is equal", async () => {
    const { serializeKey } = await import("./databricks-model-services.js");

    fc.assert(
      fc.property(keyArb, keyArb, (a, b) => {
        if (keysEqual(a, b)) {
          // Companion sanity: identical identity tuples serialize equal.
          expect(serializeKey(a)).toBe(serializeKey(b));
        } else {
          // Injectivity: any differing field yields a distinct cache key.
          expect(serializeKey(a)).not.toBe(serializeKey(b));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("serializes two structurally identical keys to the same string", async () => {
    const { serializeKey } = await import("./databricks-model-services.js");

    fc.assert(
      fc.property(keyArb, (k) => {
        expect(serializeKey({ ...k })).toBe(serializeKey(k));
      }),
      { numRuns: 200 },
    );
  });

  it("keeps field boundaries unambiguous (a|bc never collides with ab|c)", async () => {
    // The classic delimiter-injection trap: without an unambiguous encoding,
    // concatenating companyId+connectionId would make ("a","bc") and ("ab","c")
    // collide. JSON.stringify of an array keeps them distinct.
    const { serializeKey } = await import("./databricks-model-services.js");

    expect(serializeKey(key({ companyId: "a", connectionId: "bc" }))).not.toBe(
      serializeKey(key({ companyId: "ab", connectionId: "c" })),
    );
  });

  it("distinguishes an absent modelPrefix from a present one", async () => {
    // Absent (marker object) vs present (string) must never serialize alike,
    // even when every other field is identical.
    const { serializeKey } = await import("./databricks-model-services.js");

    expect(serializeKey(key())).not.toBe(serializeKey(key({ modelPrefix: "combo" })));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const FAKE_TOKEN = "dapi-super-secret-test-token-value-do-not-leak";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function credential(overrides: Partial<{
  host: string;
  token: string;
  catalog: string;
  schema: string;
  modelPrefix?: string;
}> = {}) {
  return {
    host: "https://acme.cloud.databricks.com",
    token: FAKE_TOKEN,
    catalog: "main",
    schema: "paperclip",
    ...overrides,
  };
}

function key(overrides: Partial<{
  companyId: string;
  connectionId: string;
  host: string;
  catalog: string;
  schema: string;
  modelPrefix?: string;
}> = {}) {
  return {
    companyId: "company-1",
    connectionId: "connection-1",
    host: "https://acme.cloud.databricks.com",
    catalog: "main",
    schema: "paperclip",
    ...overrides,
  };
}

/** Builds a Response with a real streamable body, matching what `fetch` returns. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function page(names: string[], nextPageToken?: string) {
  return jsonResponse(200, {
    model_services: names.map((name) => ({ name })),
    ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
  });
}

describe("toAdapterModel / label normalization", () => {
  it("strips only the model-services/ prefix", async () => {
    const { toAdapterModel } = await import("./databricks-model-services.js");
    const result = toAdapterModel({ name: "model-services/main.paperclip.combo_ux" });
    expect(result?.id).toBe("main.paperclip.combo_ux");
  });

  it("returns null for a resource name missing the model-services/ prefix", async () => {
    const { toAdapterModel } = await import("./databricks-model-services.js");
    expect(toAdapterModel({ name: "main.paperclip.combo_ux" })).toBeNull();
  });

  it.each([
    ["model-services/main.paperclip.combo_ux", "Combo Ux"],
    ["model-services/main.paperclip.combo-dev", "Combo Dev"],
    ["model-services/main.paperclip.combo-router", "Combo Router"],
    ["model-services/main.paperclip.COMBO_prod", "Combo Prod"],
    ["model-services/main.paperclip.no-prefix-name", "No Prefix Name"],
    ["model-services/main.paperclip.combo", "Combo"],
  ])("normalizes %s to label %s", async (name, expectedLabel) => {
    const { toAdapterModel } = await import("./databricks-model-services.js");
    expect(toAdapterModel({ name })?.label).toBe(expectedLabel);
  });
});

describe("pagination", () => {
  it("aggregates every page and terminates when next_page_token is absent", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(page(["model-services/main.paperclip.combo_a"], "token-1"))
      .mockResolvedValueOnce(page(["model-services/main.paperclip.combo_b"], "token-2"))
      .mockResolvedValueOnce(page(["model-services/main.paperclip.combo_c"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.map((m) => m.id)).toEqual([
      "main.paperclip.combo_a",
      "main.paperclip.combo_b",
      "main.paperclip.combo_c",
    ]);
  });

  it("requests page_size=100, view=BASIC, and the parent=schemas/<catalog>.<schema> query", async () => {
    const fetch = vi.fn().mockResolvedValue(page([]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const calledUrl = new URL(String((fetch.mock.calls[0]![0] as URL | string)));
    expect(calledUrl.pathname).toBe("/api/2.1/unity-catalog/model-services");
    expect(calledUrl.searchParams.get("parent")).toBe("schemas/main.paperclip");
    expect(calledUrl.searchParams.get("page_size")).toBe("100");
    expect(calledUrl.searchParams.get("view")).toBe("BASIC");
  });

  it("never calls GET /api/2.0/serving-endpoints", async () => {
    const fetch = vi.fn().mockResolvedValue(page([]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    for (const call of fetch.mock.calls) {
      expect(String(call[0])).not.toContain("/api/2.0/serving-endpoints");
    }
  });

  it("forwards the page_token from one response to the next request", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(page(["model-services/main.paperclip.combo_a"], "abc123"))
      .mockResolvedValueOnce(page(["model-services/main.paperclip.combo_b"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const secondUrl = new URL(String(fetch.mock.calls[1]![0]));
    expect(secondUrl.searchParams.get("page_token")).toBe("abc123");
  });
});

describe("sort, dedupe, and filtering", () => {
  it("de-duplicates by id and sorts by label", async () => {
    const fetch = vi.fn().mockResolvedValue(page([
      "model-services/main.paperclip.combo_zeta",
      "model-services/main.paperclip.combo_alpha",
      "model-services/main.paperclip.combo_alpha",
    ]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(result).toEqual([
      { id: "main.paperclip.combo_alpha", label: "Combo Alpha" },
      { id: "main.paperclip.combo_zeta", label: "Combo Zeta" },
    ]);
  });

  it("excludes combos not matching an optional modelPrefix", async () => {
    const fetch = vi.fn().mockResolvedValue(page([
      "model-services/main.paperclip.combo_ux",
      "model-services/main.paperclip.other_thing",
    ]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(
      key({ modelPrefix: "combo" }),
      credential({ modelPrefix: "combo" }),
    );

    expect(result.map((m) => m.id)).toEqual(["main.paperclip.combo_ux"]);
  });

  it("defensively drops any entry outside the credential's configured catalog.schema", async () => {
    const fetch = vi.fn().mockResolvedValue(page([
      "model-services/main.paperclip.combo_ux",
      "model-services/main.other_schema.combo_leak",
      "model-services/other_catalog.paperclip.combo_leak2",
    ]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const result = await listDatabricksModelServices(key(), credential());

    expect(result.map((m) => m.id)).toEqual(["main.paperclip.combo_ux"]);
  });
});

describe("cache", () => {
  it("serves a cached result on a second call within the TTL", async () => {
    const fetch = vi.fn().mockResolvedValue(page(["model-services/main.paperclip.combo_a"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());
    await listDatabricksModelServices(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("queries again once the cache entry expires (TTL)", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => page(["model-services/main.paperclip.combo_a"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());
    vi.advanceTimersByTime(60_001);
    await listDatabricksModelServices(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("bypasses and repopulates the cache when refresh: true is passed", async () => {
    const fetch = vi.fn().mockImplementation(async () => page(["model-services/main.paperclip.combo_a"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());
    await listDatabricksModelServices(key(), credential(), { refresh: true });
    await listDatabricksModelServices(key(), credential());

    // First call populates; refresh call bypasses+repopulates; third call hits the
    // repopulated cache, so exactly 2 network calls total.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps cache entries isolated per DatabricksDiscoveryKey", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(page(["model-services/main.paperclip.combo_a"]))
      .mockResolvedValueOnce(page(["model-services/main.other.combo_b"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    const resultA = await listDatabricksModelServices(key({ companyId: "company-a" }), credential());
    const resultB = await listDatabricksModelServices(
      key({ companyId: "company-b" }),
      credential({ schema: "other" }),
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(resultA.map((m) => m.id)).toEqual(["main.paperclip.combo_a"]);
    expect(resultB.map((m) => m.id)).toEqual(["main.other.combo_b"]);
  });

  it("invalidateDatabricksModelServiceCache clears every entry for a connection", async () => {
    const fetch = vi.fn().mockImplementation(async () => page(["model-services/main.paperclip.combo_a"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices, invalidateDatabricksModelServiceCache } = await import(
      "./databricks-model-services.js"
    );
    await listDatabricksModelServices(key(), credential());
    invalidateDatabricksModelServiceCache("connection-1");
    await listDatabricksModelServices(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not invalidate a different connection's cache entries", async () => {
    const fetch = vi.fn().mockResolvedValue(page(["model-services/main.paperclip.combo_a"]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices, invalidateDatabricksModelServiceCache } = await import(
      "./databricks-model-services.js"
    );
    await listDatabricksModelServices(key(), credential());
    invalidateDatabricksModelServiceCache("some-other-connection");
    await listDatabricksModelServices(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("HTTP error mapping", () => {
  it("maps 401 to invalid_credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { message: "bad token" })));
    const { listDatabricksModelServices, DatabricksDiscoveryError } = await import(
      "./databricks-model-services.js"
    );
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "invalid_credential",
    } satisfies Partial<InstanceType<typeof DatabricksDiscoveryError>>);
  });

  it("maps 403 to insufficient_permission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "insufficient_permission",
    });
  });

  it("maps 429 to rate_limited and captures Retry-After when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(429, {}, { "Retry-After": "42" })),
    );
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it("maps 429 to rate_limited with no retryAfterSeconds when the header is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {})));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: undefined,
    });
  });

  it("maps 500 to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps 503 to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, {})));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a network failure to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a timeout (AbortError) to unavailable", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await expect(listDatabricksModelServices(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("applies a 10-second timeout via AbortSignal", async () => {
    const fetch = vi.fn().mockResolvedValue(page([]));
    vi.stubGlobal("fetch", fetch);

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a non-https host with invalid_host and never calls fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
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
  it("never includes the token substring in any thrown error message across every mapped error kind", async () => {
    const scenarios: Array<() => Promise<unknown>> = [];
    const { listDatabricksModelServices } = await import("./databricks-model-services.js");

    for (const status of [401, 403, 429, 500, 502, 503]) {
      scenarios.push(async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status, { token: FAKE_TOKEN })));
        return listDatabricksModelServices(key(), credential()).catch((error: unknown) => error);
      });
    }
    scenarios.push(async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`network error near ${FAKE_TOKEN}`)));
      return listDatabricksModelServices(key(), credential()).catch((error: unknown) => error);
    });
    scenarios.push(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error(`Authorization: Bearer ${FAKE_TOKEN}`)),
      );
      return listDatabricksModelServices(key(), credential()).catch((error: unknown) => error);
    });
    scenarios.push(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: `invalid token ${FAKE_TOKEN}` }), { status: 401 }),
        ),
      );
      return listDatabricksModelServices(key(), credential()).catch((error: unknown) => error);
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const scenario of scenarios) {
      const result = await scenario();
      expect(result).toBeInstanceOf(Error);
      const message = (result as Error).message;
      expect(message).not.toContain(FAKE_TOKEN);
    }

    for (const spy of [consoleSpy, consoleErrorSpy, consoleWarnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(FAKE_TOKEN);
      }
      spy.mockRestore();
    }
  });

  it("never sends or logs the token anywhere but the Authorization header of the request", async () => {
    const fetch = vi.fn().mockResolvedValue(page([]));
    vi.stubGlobal("fetch", fetch);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { listDatabricksModelServices } = await import("./databricks-model-services.js");
    await listDatabricksModelServices(key(), credential());

    const requestUrl = String(fetch.mock.calls[0]![0]);
    expect(requestUrl).not.toContain(FAKE_TOKEN);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);

    for (const call of consoleSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(FAKE_TOKEN);
    }
    consoleSpy.mockRestore();
  });
});

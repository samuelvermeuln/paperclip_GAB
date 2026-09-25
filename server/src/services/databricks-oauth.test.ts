import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabricksDiscoveryKey } from "./databricks-model-services.js";
import type { DatabricksOAuthCredentialInput } from "./databricks-oauth.js";

// Sentinel values: distinctive strings that must never surface in an error
// message, a thrown value, a request URL, or a console log. Using unmistakable
// markers lets the no-leak assertions catch even an accidental partial echo.
const CLIENT_ID = "sp-client-id-abcdef";
const CLIENT_SECRET = "clientSecret-SENTINEL-do-not-leak-9f8e7d6c";
const ACCESS_TOKEN = "accessToken-SENTINEL-do-not-leak-1a2b3c4d";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Each test dynamically re-imports the module so it starts with an empty
  // token cache, `pending` map, and connection-key index.
  vi.resetModules();
});

function credential(
  overrides: Partial<DatabricksOAuthCredentialInput> = {},
): DatabricksOAuthCredentialInput {
  return {
    host: "https://acme.cloud.databricks.com",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
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
function tokenResponse(accessToken: string, expiresIn: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
    headers,
  });
}

/** Any JSON response (used for error statuses) with a real, streamable body. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function spyOnConsole() {
  return [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
  ];
}

describe("fetchDatabricksAccessToken — token exchange", () => {
  it("POSTs grant_type=client_credentials to /oidc/v1/token with HTTP Basic auth", async () => {
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await fetchDatabricksAccessToken(credential());

    const url = new URL(String(fetch.mock.calls[0]![0]));
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(url.pathname).toBe("/oidc/v1/token");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("grant_type=client_credentials");
    const headers = new Headers(init.headers);
    const expectedBasic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    expect(headers.get("authorization")).toBe(`Basic ${expectedBasic}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the access token and derives expiresAt from expires_in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600)));

    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    const result = await fetchDatabricksAccessToken(credential());

    expect(result.token).toBe(ACCESS_TOKEN);
    expect(result.expiresAt).toBe(1_000_000 + 3600 * 1000);
  });

  it("maps a response missing access_token to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { expires_in: 3600 })));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a malformed (non-JSON) token response body to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json at all", { status: 200 })));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("fetchDatabricksAccessToken — error classification", () => {
  it("maps 401 to invalid_credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { message: "bad creds" })));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "invalid_credential",
    });
  });

  it("maps 403 to insufficient_permission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "insufficient_permission",
    });
  });

  it("maps 429 to rate_limited and captures Retry-After when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(429, {}, { "Retry-After": "42" })),
    );
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it("maps 429 to rate_limited with no retryAfterSeconds when the header is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {})));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: undefined,
    });
  });

  it("maps 500 to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps 503 to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, {})));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a network failure to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a timeout (TimeoutError) to unavailable", async () => {
    const timeoutError = new Error("The operation timed out");
    timeoutError.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a timeout (AbortError) to unavailable", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(fetchDatabricksAccessToken(credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("resolveDatabricksAccessToken — cache behavior", () => {
  it("exchanges exactly once on a cache miss, then serves the cached token without network I/O", async () => {
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");
    const first = await resolveDatabricksAccessToken(key(), credential());
    const second = await resolveDatabricksAccessToken(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(1);
    // The cached path returns the very same object it stored — proof no second
    // exchange occurred while the token had well over 60s of life left.
    expect(second).toBe(first);
    expect(second.token).toBe(ACCESS_TOKEN);
  });

  it("does NOT serve a cached token within 60s of its expiry — it triggers a fresh exchange", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // expires_in of 90s: at T0 the token has 90s of life (outside the 60s
    // margin, so reusable); after advancing 31s it has 59s left (inside the
    // margin), so a second resolve must exchange again rather than reuse it.
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 90));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");
    await resolveDatabricksAccessToken(key(), credential());
    vi.advanceTimersByTime(31_000);
    await resolveDatabricksAccessToken(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("still serves the cached token while it has more than the 60s margin of life left", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");
    await resolveDatabricksAccessToken(key(), credential());
    // 3600s - 100s = 3500s of life remaining, comfortably outside the margin.
    vi.advanceTimersByTime(100_000);
    await resolveDatabricksAccessToken(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls for the same key into a single exchange", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetch = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");
    const p1 = resolveDatabricksAccessToken(key(), credential());
    const p2 = resolveDatabricksAccessToken(key(), credential());
    const p3 = resolveDatabricksAccessToken(key(), credential());
    resolveFetch(tokenResponse(ACCESS_TOKEN, 3600));
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(t1.token).toBe(ACCESS_TOKEN);
    // All three callers share the single in-flight exchange result.
    expect(t2).toBe(t1);
    expect(t3).toBe(t1);
  });

  it("does not coalesce calls for different keys", async () => {
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");
    await Promise.all([
      resolveDatabricksAccessToken(key({ companyId: "company-a" }), credential()),
      resolveDatabricksAccessToken(key({ companyId: "company-b" }), credential()),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh bypasses a valid cached token and exchanges a fresh one", async () => {
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");
    await resolveDatabricksAccessToken(key(), credential());
    await resolveDatabricksAccessToken(key(), credential(), { forceRefresh: true });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed exchange, so a later call retries", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockImplementationOnce(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");
    await expect(resolveDatabricksAccessToken(key(), credential())).rejects.toMatchObject({
      kind: "unavailable",
    });
    const retried = await resolveDatabricksAccessToken(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retried.token).toBe(ACCESS_TOKEN);
  });
});

describe("invalidateDatabricksAccessToken", () => {
  it("clears every cached entry for a connection, across all credential versions", async () => {
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken, invalidateDatabricksAccessToken } = await import(
      "./databricks-oauth.js"
    );
    const v1 = key({ credentialVersion: "1" });
    const v2 = key({ credentialVersion: "2" });

    await resolveDatabricksAccessToken(v1, credential()); // exchange #1
    await resolveDatabricksAccessToken(v2, credential()); // exchange #2 (distinct key)
    await resolveDatabricksAccessToken(v1, credential()); // cache hit
    await resolveDatabricksAccessToken(v2, credential()); // cache hit
    expect(fetch).toHaveBeenCalledTimes(2);

    invalidateDatabricksAccessToken("connection-1");

    await resolveDatabricksAccessToken(v1, credential()); // exchange #3
    await resolveDatabricksAccessToken(v2, credential()); // exchange #4
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("leaves another connection's cached entries intact", async () => {
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);

    const { resolveDatabricksAccessToken, invalidateDatabricksAccessToken } = await import(
      "./databricks-oauth.js"
    );
    await resolveDatabricksAccessToken(key(), credential());
    invalidateDatabricksAccessToken("some-other-connection");
    await resolveDatabricksAccessToken(key(), credential());

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("no secret in observable surfaces (Property 3)", () => {
  it("never includes the clientSecret or the token value in any thrown error or console output", async () => {
    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");

    // Each scenario feeds a response/error whose body or message deliberately
    // embeds both sentinels, so a leak into the classified error would be
    // caught. The service must always throw a fixed, generic message per kind.
    const scenarios: Array<() => Promise<unknown>> = [];
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      scenarios.push(async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            jsonResponse(status, { clientSecret: CLIENT_SECRET, access_token: ACCESS_TOKEN }),
          ),
        );
        return fetchDatabricksAccessToken(credential()).catch((error: unknown) => error);
      });
    }
    scenarios.push(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error(`connect failed secret=${CLIENT_SECRET} token=${ACCESS_TOKEN}`)),
      );
      return fetchDatabricksAccessToken(credential()).catch((error: unknown) => error);
    });
    scenarios.push(async () => {
      const timeoutError = new Error(`aborted with ${CLIENT_SECRET}`);
      timeoutError.name = "TimeoutError";
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));
      return fetchDatabricksAccessToken(credential()).catch((error: unknown) => error);
    });
    scenarios.push(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(`garbage ${CLIENT_SECRET} ${ACCESS_TOKEN}`, { status: 200 })),
      );
      return fetchDatabricksAccessToken(credential()).catch((error: unknown) => error);
    });

    const consoleSpies = spyOnConsole();

    for (const scenario of scenarios) {
      const error = await scenario();
      expect(error).toBeInstanceOf(Error);
      const surfaces = [
        (error as Error).message,
        (error as Error).stack ?? "",
        String(error),
      ].join("\n");
      expect(surfaces).not.toContain(CLIENT_SECRET);
      expect(surfaces).not.toContain(ACCESS_TOKEN);
    }

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(CLIENT_SECRET);
        expect(serialized).not.toContain(ACCESS_TOKEN);
      }
      spy.mockRestore();
    }
  });

  it("never puts the raw clientSecret in the request URL and logs nothing on a successful exchange", async () => {
    const fetch = vi.fn().mockImplementation(async () => tokenResponse(ACCESS_TOKEN, 3600));
    vi.stubGlobal("fetch", fetch);
    const consoleSpies = spyOnConsole();

    const { fetchDatabricksAccessToken } = await import("./databricks-oauth.js");
    await fetchDatabricksAccessToken(credential());

    // The clientSecret only ever travels base64-encoded inside the Basic auth
    // header — never in the URL, and nothing is logged.
    const requestUrl = String(fetch.mock.calls[0]![0]);
    expect(requestUrl).not.toContain(CLIENT_SECRET);

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(CLIENT_SECRET);
        expect(serialized).not.toContain(ACCESS_TOKEN);
      }
      spy.mockRestore();
    }
  });
});

describe("resolveDatabricksAccessToken — never serves an expired/near-expiry token (Property 4)", () => {
  // **Validates: Requirements 4.7**
  //
  // Property 4 (Token nunca expirado é usado): every token handed back by
  // `resolveDatabricksAccessToken` — whether reused from the cache or freshly
  // exchanged — has more than the 60s safety margin of life left at the instant
  // it is returned. We drive the mocked token endpoint so each *fresh* exchange
  // returns a token whose `expires_in` is strictly greater than the 60s margin,
  // then advance the clock arbitrarily between reads: small advances keep the
  // cached token reusable, large advances push it into the margin or past
  // expiry and must force a fresh exchange rather than serve a stale token.
  it("∀ random expires_in / clock advances, a resolved token's expiresAt is always > now + 60s", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A plausible epoch-ms starting point for the run's fake clock.
        fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
        fc.array(
          fc.record({
            // Databricks issues tokens whose lifetime is comfortably above the
            // 60s margin; keep expires_in strictly > 60s so a fresh exchange
            // also satisfies the invariant (the cache guard covers reuse).
            expiresInSeconds: fc.integer({ min: 61, max: 7_200 }),
            // Time elapsed before this read: 0 (immediate re-read) through two
            // hours (well past the longest generated lifetime).
            advanceMs: fc.integer({ min: 0, max: 7_200_000 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (startTime, steps) => {
          // Fresh module state (empty cache / pending / key index) and a fresh
          // fake clock for every generated sequence.
          vi.resetModules();
          vi.useFakeTimers();
          try {
            vi.setSystemTime(startTime);

            // The mocked endpoint returns whatever expiry the current step asks
            // for, so each fresh exchange mints a token with the generated life.
            let currentExpiresIn = steps[0]!.expiresInSeconds;
            const fetch = vi
              .fn()
              .mockImplementation(async () => tokenResponse(ACCESS_TOKEN, currentExpiresIn));
            vi.stubGlobal("fetch", fetch);

            const { resolveDatabricksAccessToken } = await import("./databricks-oauth.js");

            let now = startTime;
            for (const step of steps) {
              now += step.advanceMs;
              vi.setSystemTime(now);
              currentExpiresIn = step.expiresInSeconds;

              const result = await resolveDatabricksAccessToken(key(), credential());

              expect(typeof result.token).toBe("string");
              expect(result.token.length).toBeGreaterThan(0);
              // The core invariant: a token is never handed out within (or past)
              // the 60s expiry margin at the moment it is returned.
              expect(result.expiresAt).toBeGreaterThan(Date.now() + 60_000);
            }
          } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

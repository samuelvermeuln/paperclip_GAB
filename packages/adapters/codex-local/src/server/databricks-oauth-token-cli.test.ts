import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exchangeToken, readCredential, runCli } from "./databricks-oauth-token-cli.js";

// --- Fixtures ---------------------------------------------------------------
//
// These tests validate the `paperclip-databricks-oauth-token` bin (task 9.1)
// against Property 3 (no secret on any observable surface) and Requirements
// 4.5/4.6/4.8. The `clientSecret` and the minted `access_token` are the two
// values that must never leak to stdout (beyond the token itself), stderr, the
// request URL, the request body, or the process argv. Each value carries a
// distinct sentinel so a leak into any surface is unambiguous.

const HOST = "https://acme.cloud.databricks.com";
const CLIENT_ID = "svc-principal-client-id";
const CLIENT_SECRET = "SENTINEL_CLIENT_SECRET_do_not_leak_1234567890";
const ACCESS_TOKEN = "SENTINEL_ACCESS_TOKEN_minted_abcdef";

/** Captures the CLI's stdout/stderr instead of the real process streams. */
function createIo(env: NodeJS.ProcessEnv) {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      env,
      stdout: (data: string) => {
        out.stdout += data;
      },
      stderr: (data: string) => {
        out.stderr += data;
      },
    },
  };
}

/** Stubs the global `fetch` and returns the mock so tests can inspect the call. */
function stubFetch(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
    typeof response === "function" ? response() : response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Writes a temp credential file and returns its path; cleaned up in afterEach. */
const tempFiles: string[] = [];
async function writeCredentialFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-databricks-cred-"));
  const filePath = path.join(dir, "databricks-credential.json");
  await fs.writeFile(filePath, contents, "utf8");
  tempFiles.push(dir);
  return filePath;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempFiles.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runCli — success", () => {
  it("extracts access_token from a valid JSON response and prints ONLY the token to stdout", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ access_token: ACCESS_TOKEN, token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const filePath = await writeCredentialFile(
      JSON.stringify({ host: HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    );
    const { out, io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    const code = await runCli(io);

    expect(code).toBe(0);
    // Only the token, with no trailing newline or any other character.
    expect(out.stdout).toBe(ACCESS_TOKEN);
    expect(out.stderr).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POSTs client_credentials to {host}/oidc/v1/token", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ access_token: ACCESS_TOKEN }), { status: 200 }),
    );
    const filePath = await writeCredentialFile(
      JSON.stringify({ host: HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    );
    const { io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    await runCli(io);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`${HOST}/oidc/v1/token`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=client_credentials");
  });
});

describe("runCli — failure (sanitized stderr, non-zero exit)", () => {
  it("rejects a missing DATABRICKS_CREDENTIAL_FILE without touching the network", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 200 }));
    const { out, io } = createIo({});

    const code = await runCli(io);

    expect(code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("DATABRICKS_CREDENTIAL_FILE is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a credential file that does not exist", async () => {
    stubFetch(new Response(null, { status: 200 }));
    const { out, io } = createIo({
      DATABRICKS_CREDENTIAL_FILE: path.join(os.tmpdir(), "paperclip-does-not-exist-xyz.json"),
    });

    const code = await runCli(io);

    expect(code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Failed to read the Databricks credential file");
  });

  it("rejects a malformed (non-JSON) credential file without echoing its contents", async () => {
    stubFetch(new Response(null, { status: 200 }));
    // Malformed JSON that still embeds the secret sentinel, to prove the parse
    // error message never echoes the file contents.
    const filePath = await writeCredentialFile(`{ "clientSecret": "${CLIENT_SECRET}" `);
    const { out, io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    const code = await runCli(io);

    expect(code).toBe(1);
    expect(out.stderr).toContain("not valid JSON");
    expect(out.stderr).not.toContain(CLIENT_SECRET);
  });

  it("rejects a credential file missing required fields", async () => {
    stubFetch(new Response(null, { status: 200 }));
    const filePath = await writeCredentialFile(JSON.stringify({ host: HOST, clientId: CLIENT_ID }));
    const { out, io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    const code = await runCli(io);

    expect(code).toBe(1);
    expect(out.stderr).toContain("missing required fields");
  });

  it("rejects an HTTP error response with a status-only message, never the response body", async () => {
    // The upstream error body echoes the secret; it must never reach stderr.
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ error: "invalid_client", detail: CLIENT_SECRET }), {
        status: 401,
      }),
    );
    const filePath = await writeCredentialFile(
      JSON.stringify({ host: HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    );
    const { out, io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    const code = await runCli(io);

    expect(code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("HTTP 401");
    expect(out.stderr).not.toContain(CLIENT_SECRET);
    expect(out.stderr).not.toContain("invalid_client");
  });

  it("classifies a network/timeout failure without surfacing the credential", async () => {
    stubFetch(() => Promise.reject(new Error("fetch failed")));
    const filePath = await writeCredentialFile(
      JSON.stringify({ host: HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    );
    const { out, io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    const code = await runCli(io);

    expect(code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("could not be reached");
    expect(out.stderr).not.toContain(CLIENT_SECRET);
  });
});

describe("Property 3 — clientSecret never on an observable surface", () => {
  it("passes the secret only inside the Basic auth header, never in argv/URL/body/stdout/stderr", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ access_token: ACCESS_TOKEN }), { status: 200 }),
    );
    const filePath = await writeCredentialFile(
      JSON.stringify({ host: HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    );
    const { out, io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    const code = await runCli(io);
    expect(code).toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];

    // The child helper never receives the secret as a command-line argument:
    // it is delivered exclusively through the credential file.
    expect(process.argv.some((arg) => arg.includes(CLIENT_SECRET))).toBe(false);

    // The secret is absent from every plaintext surface of the request: the
    // URL and the form body carry no secret, and neither does stdout/stderr.
    expect(String(url)).not.toContain(CLIENT_SECRET);
    expect(String(init.body ?? "")).not.toContain(CLIENT_SECRET);
    expect(out.stdout).not.toContain(CLIENT_SECRET);
    expect(out.stderr).not.toContain(CLIENT_SECRET);

    // The only place the secret appears is the HTTP Basic auth header, and only
    // base64-encoded — so the plaintext never appears even in the serialized call.
    const headers = init.headers as Record<string, string>;
    const authorization = headers.Authorization;
    expect(authorization.startsWith("Basic ")).toBe(true);
    expect(authorization).not.toContain(CLIENT_SECRET);
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);

    // The full serialized call carries no plaintext secret anywhere.
    const serializedCall = JSON.stringify({ url: String(url), init });
    expect(serializedCall).not.toContain(CLIENT_SECRET);
  });

  it.each([
    "colon:in:secret",
    "with spaces and = signs",
    "unicode- секрет-🔐",
    'quote"and\\backslash',
    "Zm9vOmJhcg==", // already base64-shaped
  ])("never leaks a tricky secret shape (%s) to stderr on failure", async (secret) => {
    stubFetch(
      new Response(JSON.stringify({ error: "invalid_client", detail: secret }), { status: 403 }),
    );
    const filePath = await writeCredentialFile(
      JSON.stringify({ host: HOST, clientId: CLIENT_ID, clientSecret: secret }),
    );
    const { out, io } = createIo({ DATABRICKS_CREDENTIAL_FILE: filePath });

    const code = await runCli(io);

    expect(code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toContain(secret);
    expect(out.stderr).toContain("HTTP 403");
  });
});

describe("exchangeToken / readCredential (unit-level)", () => {
  it("readCredential rejects a token response with no access_token", async () => {
    stubFetch(new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }));
    const token = exchangeToken({ host: HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await expect(token).rejects.toThrow("did not contain an access token");
  });

  it("readCredential returns the parsed credential for a well-formed file", async () => {
    const filePath = await writeCredentialFile(
      JSON.stringify({ host: HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    );
    await expect(readCredential({ DATABRICKS_CREDENTIAL_FILE: filePath })).resolves.toEqual({
      host: HOST,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
  });
});

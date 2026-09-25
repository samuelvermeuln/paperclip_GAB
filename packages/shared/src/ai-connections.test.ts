import { describe, expect, it } from "vitest";
import {
  createAiConnectionSchema,
  databricksConnectionConfigSchema,
  databricksOAuthCredentialSchema,
} from "./ai-connections.js";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    workspaceHost: "https://acme.cloud.databricks.com",
    catalog: "main",
    schema: "paperclip",
    ...overrides,
  };
}

describe("databricksConnectionConfigSchema", () => {
  describe("workspaceHost", () => {
    it("accepts a bare https:// origin", () => {
      const result = databricksConnectionConfigSchema.safeParse(baseConfig());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workspaceHost).toBe("https://acme.cloud.databricks.com");
      }
    });

    it("normalizes an origin that includes a trailing slash", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ workspaceHost: "https://acme.cloud.databricks.com/" }),
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workspaceHost).toBe("https://acme.cloud.databricks.com");
      }
    });

    it("rejects http:// scheme", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ workspaceHost: "http://acme.cloud.databricks.com" }),
      );

      expect(result.success).toBe(false);
    });

    it("rejects a URL with a path", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ workspaceHost: "https://acme.cloud.databricks.com/foo" }),
      );

      expect(result.success).toBe(false);
    });

    it("rejects a URL with a query string", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ workspaceHost: "https://acme.cloud.databricks.com?foo=bar" }),
      );

      expect(result.success).toBe(false);
    });

    it("rejects a URL with a fragment", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ workspaceHost: "https://acme.cloud.databricks.com#section" }),
      );

      expect(result.success).toBe(false);
    });

    it("rejects a URL with userinfo", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ workspaceHost: "https://user:pass@acme.cloud.databricks.com" }),
      );

      expect(result.success).toBe(false);
    });

    it("rejects a non-URL string", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ workspaceHost: "not-a-url" }),
      );

      expect(result.success).toBe(false);
    });
  });

  describe("catalog", () => {
    it("accepts a non-empty catalog name", () => {
      const result = databricksConnectionConfigSchema.safeParse(baseConfig({ catalog: "main" }));

      expect(result.success).toBe(true);
    });

    it("rejects an empty catalog", () => {
      const result = databricksConnectionConfigSchema.safeParse(baseConfig({ catalog: "" }));

      expect(result.success).toBe(false);
    });

    it("rejects a whitespace-only catalog", () => {
      const result = databricksConnectionConfigSchema.safeParse(baseConfig({ catalog: "   " }));

      expect(result.success).toBe(false);
    });

    it("rejects a catalog longer than 128 characters", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ catalog: "a".repeat(129) }),
      );

      expect(result.success).toBe(false);
    });

    it("accepts a catalog exactly 128 characters long", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ catalog: "a".repeat(128) }),
      );

      expect(result.success).toBe(true);
    });
  });

  describe("schema", () => {
    it("accepts a non-empty schema name", () => {
      const result = databricksConnectionConfigSchema.safeParse(baseConfig({ schema: "paperclip" }));

      expect(result.success).toBe(true);
    });

    it("rejects an empty schema", () => {
      const result = databricksConnectionConfigSchema.safeParse(baseConfig({ schema: "" }));

      expect(result.success).toBe(false);
    });

    it("rejects a schema longer than 128 characters", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ schema: "a".repeat(129) }),
      );

      expect(result.success).toBe(false);
    });
  });

  describe("modelPrefix", () => {
    it("is optional", () => {
      const config = baseConfig();
      const result = databricksConnectionConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.modelPrefix).toBeUndefined();
      }
    });

    it("accepts a valid non-empty prefix", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ modelPrefix: "combo_" }),
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.modelPrefix).toBe("combo_");
      }
    });

    it("rejects an empty-string prefix when provided", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ modelPrefix: "" }),
      );

      expect(result.success).toBe(false);
    });

    it("rejects a prefix longer than 128 characters", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ modelPrefix: "a".repeat(129) }),
      );

      expect(result.success).toBe(false);
    });
  });

  describe("strictness", () => {
    it("rejects unknown top-level fields", () => {
      const result = databricksConnectionConfigSchema.safeParse(
        baseConfig({ unexpected: "field" }),
      );

      expect(result.success).toBe(false);
    });

    it("rejects a missing required field", () => {
      const { catalog: _catalog, ...withoutCatalog } = baseConfig();
      const result = databricksConnectionConfigSchema.safeParse(withoutCatalog);

      expect(result.success).toBe(false);
    });
  });
});

/** A fully valid Databricks OAuth M2M create-connection payload. */
function baseDatabricksCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: "databricks",
    method: "oauth_m2m",
    name: "Acme Unity Gateway",
    ownership: "personal",
    clientId: "svc-principal-id",
    clientSecret: "svc-principal-secret",
    workspaceHost: "https://acme.cloud.databricks.com",
    catalog: "main",
    schema: "paperclip",
    ...overrides,
  };
}

/** The same payload with the named keys removed, to exercise the "field absent" path. */
function databricksCreateInputWithout(...keys: string[]) {
  const input: Record<string, unknown> = baseDatabricksCreateInput();
  for (const key of keys) delete input[key];
  return input;
}

function issuePaths(result: ReturnType<typeof createAiConnectionSchema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("createAiConnectionSchema — databricks branch", () => {
  const databricksRequiredFields = [
    "clientId",
    "clientSecret",
    "workspaceHost",
    "catalog",
    "schema",
  ] as const;

  it("accepts a complete OAuth M2M payload", () => {
    const result = createAiConnectionSchema.safeParse(baseDatabricksCreateInput());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("databricks");
      expect(result.data.method).toBe("oauth_m2m");
      expect(result.data.clientId).toBe("svc-principal-id");
      expect(result.data.workspaceHost).toBe("https://acme.cloud.databricks.com");
    }
  });

  describe("method must be oauth_m2m", () => {
    it("rejects method: api_key with an issue on the method field", () => {
      const result = createAiConnectionSchema.safeParse(
        baseDatabricksCreateInput({ method: "api_key" }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        const methodIssue = result.error.issues.find(
          (issue) => issue.path.join(".") === "method",
        );
        expect(methodIssue).toBeDefined();
        expect(methodIssue?.message).toContain("oauth_m2m");
      }
    });

    it("rejects method: subscription with an issue on the method field", () => {
      const result = createAiConnectionSchema.safeParse(
        baseDatabricksCreateInput({ method: "subscription" }),
      );

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("method");
    });
  });

  describe("required credential/config fields", () => {
    it("emits exactly one issue per field when all are absent", () => {
      const input = databricksCreateInputWithout(...databricksRequiredFields);
      const result = createAiConnectionSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = issuePaths(result).sort();
        expect(paths).toEqual(
          [...databricksRequiredFields].sort(),
        );
      }
    });

    for (const field of databricksRequiredFields) {
      it(`rejects when ${field} is absent, flagging that field`, () => {
        const result = createAiConnectionSchema.safeParse(
          databricksCreateInputWithout(field),
        );

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain(field);
      });

      it(`rejects when ${field} is an empty string, flagging that field`, () => {
        const result = createAiConnectionSchema.safeParse(
          baseDatabricksCreateInput({ [field]: "" }),
        );

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain(field);
      });
    }
  });
});

describe("databricksOAuthCredentialSchema", () => {
  it("accepts a valid clientId/clientSecret pair", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "svc-principal-id",
      clientSecret: "svc-principal-secret",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientId).toBe("svc-principal-id");
      expect(result.data.clientSecret).toBe("svc-principal-secret");
    }
  });

  it("trims surrounding whitespace on both fields", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "  svc-principal-id  ",
      clientSecret: "  svc-principal-secret  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientId).toBe("svc-principal-id");
      expect(result.data.clientSecret).toBe("svc-principal-secret");
    }
  });

  it("rejects a missing clientId", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientSecret: "svc-principal-secret",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing clientSecret", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "svc-principal-id",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty clientId", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "",
      clientSecret: "svc-principal-secret",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only clientSecret", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "svc-principal-id",
      clientSecret: "   ",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unexpected extra field (.strict())", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "svc-principal-id",
      clientSecret: "svc-principal-secret",
      token: "should-not-be-here",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a clientId longer than 255 characters", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "a".repeat(256),
      clientSecret: "svc-principal-secret",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a clientSecret longer than 4096 characters", () => {
    const result = databricksOAuthCredentialSchema.safeParse({
      clientId: "svc-principal-id",
      clientSecret: "a".repeat(4097),
    });

    expect(result.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { databricksConnectionConfigSchema } from "./ai-connections.js";

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

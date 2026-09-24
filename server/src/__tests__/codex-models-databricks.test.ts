import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";

const listDatabricksModelServicesMock = vi.fn();

vi.mock("../services/databricks-model-services.js", () => ({
  listDatabricksModelServices: listDatabricksModelServicesMock,
}));

const DATABRICKS_MODELS = [
  { id: "main.paperclip.combo_ux", label: "Combo Ux" },
  { id: "main.paperclip.combo_dev", label: "Combo Dev" },
];

function databricksContext(overrides: Partial<{
  companyId: string;
  connectionId?: string;
  refresh?: boolean;
  resolvedCredential?: {
    token: string;
    host: string;
    catalog: string;
    schema: string;
    modelPrefix?: string;
  };
}> = {}) {
  return {
    companyId: "company-1",
    provider: "databricks" as const,
    connectionId: "connection-1",
    resolvedCredential: {
      token: "dapi-test-token",
      host: "https://acme.cloud.databricks.com",
      catalog: "main",
      schema: "paperclip",
    },
    ...overrides,
  };
}

describe("codex-models Databricks routing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    listDatabricksModelServicesMock.mockReset();
    listDatabricksModelServicesMock.mockResolvedValue(DATABRICKS_MODELS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe("listCodexModels", () => {
    it("with no context, still returns OpenAI/fallback behavior unchanged (regression guard)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { listCodexModels, resetCodexModelsCacheForTests } = await import(
        "../adapters/codex-models.js"
      );
      resetCodexModelsCacheForTests();

      const models = await listCodexModels();

      expect(models).toEqual(codexFallbackModels);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });

    it("with a non-databricks provider context, preserves existing OpenAI/fallback behavior", async () => {
      const { listCodexModels, resetCodexModelsCacheForTests } = await import(
        "../adapters/codex-models.js"
      );
      resetCodexModelsCacheForTests();

      const models = await listCodexModels({ companyId: "company-1", provider: "openai" });

      expect(models).toEqual(codexFallbackModels);
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });

    it("with provider=databricks and a resolvedCredential, calls through to Databricks discovery and returns exactly that result", async () => {
      const { listCodexModels } = await import("../adapters/codex-models.js");

      const models = await listCodexModels(databricksContext());

      expect(models).toEqual(DATABRICKS_MODELS);
      // No OpenAI/fallback models mixed in.
      expect(models.some((m) => codexFallbackModels.some((f) => f.id === m.id))).toBe(false);
      expect(listDatabricksModelServicesMock).toHaveBeenCalledTimes(1);
      expect(listDatabricksModelServicesMock).toHaveBeenCalledWith(
        {
          companyId: "company-1",
          connectionId: "connection-1",
          host: "https://acme.cloud.databricks.com",
          catalog: "main",
          schema: "paperclip",
          modelPrefix: undefined,
        },
        {
          token: "dapi-test-token",
          host: "https://acme.cloud.databricks.com",
          catalog: "main",
          schema: "paperclip",
        },
        { refresh: undefined },
      );
    });

    it("with provider=databricks and missing resolvedCredential, throws a 422 unprocessable error", async () => {
      const { listCodexModels } = await import("../adapters/codex-models.js");

      await expect(
        listCodexModels({
          companyId: "company-1",
          provider: "databricks",
          connectionId: "connection-1",
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });

    it("with OPENAI_API_KEY set AND provider=databricks, never calls OpenAI and returns only Databricks models (Requirement 4.4)", async () => {
      process.env.OPENAI_API_KEY = "sk-test-should-not-be-used";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5-pro" }, { id: "gpt-5" }],
        }),
      } as Response);
      const { listCodexModels } = await import("../adapters/codex-models.js");

      const models = await listCodexModels(databricksContext());

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(models).toEqual(DATABRICKS_MODELS);
      expect(models.some((m) => codexFallbackModels.some((f) => f.id === m.id))).toBe(false);
      expect(models.some((m) => m.id === "gpt-5-pro" || m.id === "gpt-5")).toBe(false);
      expect(listDatabricksModelServicesMock).toHaveBeenCalledTimes(1);
    });

    it("with OPENAI_API_KEY set and provider=openai (non-Databricks), the OpenAI discovery path still runs and is unaffected by the Databricks branch", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5-pro" }, { id: "gpt-5" }],
        }),
      } as Response);
      const { listCodexModels, resetCodexModelsCacheForTests } = await import(
        "../adapters/codex-models.js"
      );
      resetCodexModelsCacheForTests();

      const models = await listCodexModels({ companyId: "company-1", provider: "openai" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(models.some((m) => m.id === "gpt-5-pro")).toBe(true);
      expect(models.some((m) => m.id === "gpt-5")).toBe(true);
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });
  });

  describe("refreshCodexModels", () => {
    it("with no context, still returns OpenAI/fallback behavior unchanged (regression guard)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { refreshCodexModels, resetCodexModelsCacheForTests } = await import(
        "../adapters/codex-models.js"
      );
      resetCodexModelsCacheForTests();

      const models = await refreshCodexModels();

      expect(models).toEqual(codexFallbackModels);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });

    it("with a non-databricks provider context, preserves existing OpenAI/fallback refresh behavior", async () => {
      const { refreshCodexModels, resetCodexModelsCacheForTests } = await import(
        "../adapters/codex-models.js"
      );
      resetCodexModelsCacheForTests();

      const models = await refreshCodexModels({ companyId: "company-1", provider: "openai" });

      expect(models).toEqual(codexFallbackModels);
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });

    it("with provider=databricks and a resolvedCredential, forces refresh and returns exactly the Databricks result", async () => {
      const { refreshCodexModels } = await import("../adapters/codex-models.js");

      const models = await refreshCodexModels(databricksContext({ refresh: false }));

      expect(models).toEqual(DATABRICKS_MODELS);
      expect(models.some((m) => codexFallbackModels.some((f) => f.id === m.id))).toBe(false);
      expect(listDatabricksModelServicesMock).toHaveBeenCalledTimes(1);
      const [, , options] = listDatabricksModelServicesMock.mock.calls[0]!;
      expect(options).toEqual({ refresh: true });
    });

    it("with provider=databricks and missing resolvedCredential, throws a 422 unprocessable error", async () => {
      const { refreshCodexModels } = await import("../adapters/codex-models.js");

      await expect(
        refreshCodexModels({
          companyId: "company-1",
          provider: "databricks",
          connectionId: "connection-1",
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });

    it("with OPENAI_API_KEY set AND provider=databricks, refresh never calls OpenAI and returns only Databricks models (Requirement 4.4)", async () => {
      process.env.OPENAI_API_KEY = "sk-test-should-not-be-used";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5-pro" }, { id: "gpt-5" }],
        }),
      } as Response);
      const { refreshCodexModels } = await import("../adapters/codex-models.js");

      const models = await refreshCodexModels(databricksContext());

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(models).toEqual(DATABRICKS_MODELS);
      expect(models.some((m) => codexFallbackModels.some((f) => f.id === m.id))).toBe(false);
      expect(models.some((m) => m.id === "gpt-5-pro" || m.id === "gpt-5")).toBe(false);
      expect(listDatabricksModelServicesMock).toHaveBeenCalledTimes(1);
    });

    it("with OPENAI_API_KEY set and provider=openai (non-Databricks), refresh's OpenAI discovery path still runs and is unaffected by the Databricks branch", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: "gpt-5" }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: "gpt-5.6-terra" }] }),
        } as Response);
      const { listCodexModels, refreshCodexModels, resetCodexModelsCacheForTests } = await import(
        "../adapters/codex-models.js"
      );
      resetCodexModelsCacheForTests();

      const initial = await listCodexModels({ companyId: "company-1", provider: "openai" });
      const refreshed = await refreshCodexModels({ companyId: "company-1", provider: "openai" });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(initial.some((m) => m.id === "gpt-5")).toBe(true);
      expect(refreshed.some((m) => m.id === "gpt-5.6-terra")).toBe(true);
      expect(listDatabricksModelServicesMock).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it } from "vitest";

import { resolveCodexBiller, resolveCodexBillingType } from "./execute.js";

// Requirement 9.1: a Databricks-active run must be attributed to
// provider "databricks" / biller "databricks" / billingType "api" in the
// run-log and cost-ledger path (server/src/services/heartbeat.ts reads
// `result.provider` / `result.biller` / `result.billingType` directly), the
// same run-log path used for every other provider's runs. These pure
// helpers decide exactly those three fields before `execute()` returns its
// `AdapterExecutionResult`.
describe("resolveCodexBillingType", () => {
  it("is 'subscription' for a non-Databricks run with no OPENAI_API_KEY (unchanged legacy behavior)", () => {
    expect(resolveCodexBillingType({}, false)).toBe("subscription");
  });

  it("is 'api' for a non-Databricks run with a non-empty OPENAI_API_KEY (unchanged legacy behavior)", () => {
    expect(resolveCodexBillingType({ OPENAI_API_KEY: "sk-test" }, false)).toBe("api");
  });

  it("is 'api' for a Databricks-active run even with no OPENAI_API_KEY set", () => {
    // A Databricks run authenticates through the Unity Gateway's external OAuth
    // M2M helper (`providerRuntimeHint`, provider === "databricks"), never
    // OPENAI_API_KEY and never a static DATABRICKS_TOKEN, so the OpenAI-only
    // fallback would otherwise misclassify it as a ChatGPT "subscription" run.
    expect(resolveCodexBillingType({}, true)).toBe("api");
  });

  it("is 'api' for a Databricks-active run regardless of an incidental OPENAI_API_KEY", () => {
    expect(resolveCodexBillingType({ OPENAI_API_KEY: "sk-test" }, true)).toBe("api");
  });
});

describe("resolveCodexBiller", () => {
  it("returns 'openai' for a non-Databricks API-key run (unchanged legacy behavior)", () => {
    expect(resolveCodexBiller({ OPENAI_API_KEY: "sk-test" }, "api", false)).toBe("openai");
  });

  it("returns 'chatgpt' for a non-Databricks subscription run (unchanged legacy behavior)", () => {
    expect(resolveCodexBiller({}, "subscription", false)).toBe("chatgpt");
  });

  it("returns 'openrouter' for a non-Databricks run routed through OpenRouter (unchanged legacy behavior)", () => {
    expect(resolveCodexBiller({ OPENROUTER_API_KEY: "or-test" }, "api", false)).toBe("openrouter");
  });

  it("returns 'databricks' for a Databricks-active run, never 'openai'/'chatgpt'/'openrouter'", () => {
    expect(resolveCodexBiller({}, "api", true)).toBe("databricks");
    expect(resolveCodexBiller({ OPENAI_API_KEY: "sk-test" }, "api", true)).toBe("databricks");
    expect(resolveCodexBiller({ OPENROUTER_API_KEY: "or-test" }, "api", true)).toBe("databricks");
  });
});

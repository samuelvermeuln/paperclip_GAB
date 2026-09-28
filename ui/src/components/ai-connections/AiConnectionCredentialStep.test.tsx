// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const mockAiConnectionsApi = vi.hoisted(() => ({
  create: vi.fn(),
  startDatabricksDiscovery: vi.fn(),
  cancelDatabricksDiscovery: vi.fn(),
  databricksCatalogs: vi.fn(),
  databricksSchemas: vi.fn(),
  databricksModelServices: vi.fn(),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mockAiConnectionsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

// A value that must never survive a submit or leak back into any observable surface.
const SECRET = "example-only-client-secret-9f3a";

function makeProps(
  overrides: Partial<ComponentProps<typeof AiConnectionCredentialStep>> = {},
): ComponentProps<typeof AiConnectionCredentialStep> {
  return {
    companyId: "company-1",
    provider: "databricks",
    name: "Databricks combos",
    ownership: "shared",
    agentIds: [],
    allAgents: true,
    onComplete: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function inputForLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((node) =>
    node.textContent?.startsWith(labelText),
  );
  if (!label) throw new Error(`No label found starting with "${labelText}"`);
  const input = label.querySelector("input");
  if (!input) throw new Error(`No input found inside label "${labelText}"`);
  return input;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((node) => node.textContent?.trim().startsWith(text));
  if (!button) throw new Error(`No button found starting with "${text}"`);
  return button;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fill(container: HTMLElement, labelText: string, value: string) {
  await act(async () => setValue(inputForLabel(container, labelText), value));
}

// Every required Databricks credential field with a distinctive filler value. Catalog and
// schema are no longer typed here — Etapa A only authenticates host/client/secret.
const REQUIRED_FIELDS: Array<[label: string, value: string]> = [
  ["Workspace URL", "https://dbc-workspace.cloud.databricks.com"],
  ["Client ID", "service-principal-id"],
  ["Client secret", SECRET],
];

async function fillAllRequired(container: HTMLElement) {
  for (const [label, value] of REQUIRED_FIELDS) {
    await fill(container, label, value);
  }
}

/** Opens the first (or second) `SearchableSelect` trigger on the page and clicks the
 * option whose visible label matches `optionLabel`. Popover content renders through a
 * portal into `document.body`, not into the local `container` — mirroring
 * `SearchableSelect.test.tsx`. `triggerIndex` distinguishes Catalog (0) from Schema (1). */
async function chooseOption(triggerIndex: number, optionLabel: string) {
  const triggers = Array.from(document.querySelectorAll("button[role='combobox']"));
  const trigger = triggers[triggerIndex] as HTMLButtonElement | undefined;
  if (!trigger) throw new Error(`No combobox trigger at index ${triggerIndex}`);
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await flushReact();
  const item = Array.from(document.querySelectorAll("[cmdk-item]")).find((node) => node.textContent?.includes(optionLabel));
  if (!item) throw new Error(`No option found for "${optionLabel}"`);
  await act(async () => item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await flushReact();
}

function defaultDiscoveryMocks() {
  mockAiConnectionsApi.startDatabricksDiscovery.mockResolvedValue({
    discoverySessionId: "draft-1",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    authStatus: "authenticated",
  });
  mockAiConnectionsApi.databricksCatalogs.mockResolvedValue({ items: [{ name: "main" }, { name: "system" }] });
  mockAiConnectionsApi.databricksSchemas.mockResolvedValue({ items: [{ name: "paperclip", catalog: "main", fullName: "main.paperclip" }] });
  mockAiConnectionsApi.databricksModelServices.mockResolvedValue({ items: [{ id: "main.paperclip.combo_ux", label: "Combo Ux" }] });
  mockAiConnectionsApi.cancelDatabricksDiscovery.mockResolvedValue({ ok: true });
}

describe("AiConnectionCredentialStep — Databricks step", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    // `SearchableSelect` (Catalog/Schema) renders through `cmdk`, which requires
    // `ResizeObserver` — absent in jsdom. Same stub as `SearchableSelect.test.tsx`.
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    globalThis.ResizeObserver = originalResizeObserver!;
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(overrides: Partial<ComponentProps<typeof AiConnectionCredentialStep>> = {}) {
    const props = makeProps(overrides);
    root ??= createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <AiConnectionCredentialStep {...props} />
      </QueryClientProvider>,
    );
    return props;
  }

  it("blocks Connect until Workspace URL, Client ID, and Client secret are filled", async () => {
    render();
    await flushReact();

    // Name arrives pre-filled from the wizard, but the credential fields do not.
    const connect = () => buttonByText(container, "Connect and find options");
    expect(connect().disabled).toBe(true);

    for (const [label, value] of REQUIRED_FIELDS.slice(0, -1)) {
      await fill(container, label, value);
      expect(connect().disabled).toBe(true);
    }

    const [lastLabel, lastValue] = REQUIRED_FIELDS[REQUIRED_FIELDS.length - 1];
    await fill(container, lastLabel, lastValue);
    expect(connect().disabled).toBe(false);

    expect(mockAiConnectionsApi.startDatabricksDiscovery).not.toHaveBeenCalled();
  });

  it("keeps Connect blocked when a required field is only whitespace", async () => {
    render();
    await flushReact();
    await fillAllRequired(container);
    expect(buttonByText(container, "Connect and find options").disabled).toBe(false);

    await fill(container, "Workspace URL", "   ");
    expect(buttonByText(container, "Connect and find options").disabled).toBe(true);
  });

  it("shows the server error and clears the secret when the connect call fails, without moving to Etapa B", async () => {
    mockAiConnectionsApi.startDatabricksDiscovery.mockRejectedValue(new Error("Databricks rejected the credentials"));
    render();
    await flushReact();
    await fillAllRequired(container);

    await act(async () => buttonByText(container, "Connect and find options").click());
    await flushReact();

    await vi.waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Databricks rejected the credentials");
    });
    // Etapa A is still shown (Client secret input still exists) and it is empty again.
    expect(inputForLabel(container, "Client secret").value).toBe("");
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });

  it("moves to Etapa B on a successful connect, clearing the secret and never rendering it again", async () => {
    defaultDiscoveryMocks();
    render();
    await flushReact();
    await fillAllRequired(container);

    await act(async () => buttonByText(container, "Connect and find options").click());
    await flushReact();

    expect(mockAiConnectionsApi.startDatabricksDiscovery).toHaveBeenCalledWith("company-1", {
      workspaceHost: "https://dbc-workspace.cloud.databricks.com",
      clientId: "service-principal-id",
      clientSecret: SECRET,
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Authenticated"));
    // Etapa A's Client secret input is gone entirely — it cannot re-render the secret.
    expect(() => inputForLabel(container, "Client secret")).toThrow();
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });

  it("shows the empty-catalogs message when the authenticated draft has no accessible catalog", async () => {
    defaultDiscoveryMocks();
    mockAiConnectionsApi.databricksCatalogs.mockResolvedValue({ items: [] });
    render();
    await flushReact();
    await fillAllRequired(container);
    await act(async () => buttonByText(container, "Connect and find options").click());
    await flushReact();

    await vi.waitFor(() => expect(container.textContent).toContain("Authenticated"));
    await act(async () => {
      const trigger = container.querySelector("button[role='combobox']") as HTMLButtonElement;
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    expect(document.body.textContent).toContain(
      "Connection authenticated. No accessible catalog was returned for this service principal.",
    );
  });

  it("selects a catalog then a schema and saves via discoverySessionId, never resending the credential", async () => {
    defaultDiscoveryMocks();
    mockAiConnectionsApi.create.mockResolvedValue({ connectionId: "conn-1", grantId: "grant-1" });
    const onComplete = vi.fn();
    render({ onComplete });
    await flushReact();
    await fillAllRequired(container);
    await act(async () => buttonByText(container, "Connect and find options").click());
    await flushReact();
    await vi.waitFor(() => expect(container.textContent).toContain("Authenticated"));

    await chooseOption(0, "main");
    await vi.waitFor(() => expect(mockAiConnectionsApi.databricksSchemas).toHaveBeenCalledWith("company-1", "draft-1", "main"));

    await chooseOption(1, "paperclip");
    await vi.waitFor(() => expect(container.textContent).toContain("combo found"));

    const save = () => buttonByText(container, "Save");
    await vi.waitFor(() => expect(save().disabled).toBe(false));
    await act(async () => save().click());
    await flushReact();

    expect(mockAiConnectionsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "databricks",
        method: "oauth_m2m",
        discoverySessionId: "draft-1",
        catalog: "main",
        schema: "paperclip",
      }),
    );
    const savedInput = mockAiConnectionsApi.create.mock.calls[0]![1];
    expect(savedInput).not.toHaveProperty("clientId");
    expect(savedInput).not.toHaveProperty("clientSecret");
    expect(savedInput).not.toHaveProperty("workspaceHost");
    await vi.waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "conn-1", grantId: "grant-1", method: "oauth_m2m" }),
      ),
    );
  });

  it("cancels the draft and returns control to the caller", async () => {
    defaultDiscoveryMocks();
    const onCancel = vi.fn();
    render({ onCancel });
    await flushReact();
    await fillAllRequired(container);
    await act(async () => buttonByText(container, "Connect and find options").click());
    await flushReact();
    await vi.waitFor(() => expect(container.textContent).toContain("Authenticated"));

    await act(async () => buttonByText(container, "Cancel").click());
    await flushReact();

    expect(mockAiConnectionsApi.cancelDatabricksDiscovery).toHaveBeenCalledWith("company-1", "draft-1");
    expect(onCancel).toHaveBeenCalled();
  });
});

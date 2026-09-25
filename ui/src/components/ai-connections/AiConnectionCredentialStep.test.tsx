// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const mockAiConnectionsApi = vi.hoisted(() => ({ create: vi.fn() }));
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

function connectButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((node) =>
    node.textContent?.trim().startsWith("Connect"),
  );
  if (!button) throw new Error("No Connect button found");
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

// Every required Databricks credential field with a distinctive filler value.
const REQUIRED_FIELDS: Array<[label: string, value: string]> = [
  ["Workspace URL", "https://dbc-workspace.cloud.databricks.com"],
  ["Client ID", "service-principal-id"],
  ["Client secret", SECRET],
  ["Catalog", "main"],
  ["Schema", "default"],
];

async function fillAllRequired(container: HTMLElement) {
  for (const [label, value] of REQUIRED_FIELDS) {
    await fill(container, label, value);
  }
}

describe("AiConnectionCredentialStep — Databricks step", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
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

  it("blocks Connect until Workspace URL, Client ID, Client secret, Catalog, and Schema are filled", async () => {
    render();
    await flushReact();

    // Name arrives pre-filled from the wizard, but the credential fields do not.
    expect(connectButton(container).disabled).toBe(true);

    // Each required field on its own leaves the submit blocked...
    for (const [label, value] of REQUIRED_FIELDS.slice(0, -1)) {
      await fill(container, label, value);
      expect(connectButton(container).disabled).toBe(true);
    }

    // ...only once the final required field is filled does Connect enable.
    const [lastLabel, lastValue] = REQUIRED_FIELDS[REQUIRED_FIELDS.length - 1];
    await fill(container, lastLabel, lastValue);
    expect(connectButton(container).disabled).toBe(false);

    // Prefix is optional and never gates submission.
    await fill(container, "Prefix", "combo-");
    expect(connectButton(container).disabled).toBe(false);

    expect(mockAiConnectionsApi.create).not.toHaveBeenCalled();
  });

  it("keeps Connect blocked when a required field is only whitespace", async () => {
    render();
    await flushReact();
    await fillAllRequired(container);
    expect(connectButton(container).disabled).toBe(false);

    await fill(container, "Catalog", "   ");
    expect(connectButton(container).disabled).toBe(true);
  });

  it("shows the server error when connection creation fails", async () => {
    mockAiConnectionsApi.create.mockRejectedValue(new Error("Databricks rejected the credentials"));
    render();
    await flushReact();
    await fillAllRequired(container);

    await act(async () => connectButton(container).click());
    await flushReact();

    await vi.waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Databricks rejected the credentials");
    });
  });

  it("clears the client secret and never renders it back after a successful submit", async () => {
    mockAiConnectionsApi.create.mockResolvedValue({ connectionId: "conn-1", grantId: "grant-1" });
    const onComplete = vi.fn();
    render({ onComplete });
    await flushReact();
    await fillAllRequired(container);

    await act(async () => connectButton(container).click());
    await flushReact();

    // The secret is handed only to the injected create action, never re-derived.
    expect(mockAiConnectionsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ provider: "databricks", method: "oauth_m2m", clientSecret: SECRET }),
    );
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1", grantId: "grant-1", method: "oauth_m2m" }),
    ));

    // After the submit settles, the write-only secret field is empty again...
    await vi.waitFor(() => expect(inputForLabel(container, "Client secret").value).toBe(""));
    // ...and the secret value does not appear in any rendered input or text.
    for (const input of container.querySelectorAll("input")) {
      expect(input.value).not.toContain(SECRET);
    }
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });

  it("clears the client secret and never renders it back after a failed submit", async () => {
    mockAiConnectionsApi.create.mockRejectedValue(new Error("Databricks rejected the credentials"));
    render();
    await flushReact();
    await fillAllRequired(container);

    await act(async () => connectButton(container).click());
    await flushReact();

    // The failed submit surfaces the error but still wipes the secret from the UI.
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Databricks rejected the credentials",
      );
      expect(inputForLabel(container, "Client secret").value).toBe("");
    });
    for (const input of container.querySelectorAll("input")) {
      expect(input.value).not.toContain(SECRET);
    }
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  getRuntimeConfig: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(),
  loadModelsConfigWithSource: vi.fn(),
  printModelTable: vi.fn(),
  readActiveGatewayLockIdentity: vi.fn(),
  requestExitAfterOneShotOutput: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: mocks.callGateway,
  isImplicitLocalGatewayTarget: mocks.isImplicitLocalGatewayTarget,
}));

vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: mocks.readActiveGatewayLockIdentity,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfigWithSource: mocks.loadModelsConfigWithSource,
}));

vi.mock("./list.table.js", () => ({
  printModelTable: mocks.printModelTable,
}));

vi.mock("../../cli/one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutput,
}));

import { modelsListCommand } from "./list.list-command.js";

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("models list Gateway catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { mode: "local" } });
    mocks.isImplicitLocalGatewayTarget.mockResolvedValue(true);
    mocks.readActiveGatewayLockIdentity.mockResolvedValue({ port: 18789 });
    mocks.loadModelsConfigWithSource.mockRejectedValue(
      new Error("models.providers.google.apiKey is unresolved in the active runtime snapshot"),
    );
    mocks.callGateway.mockResolvedValue({
      models: [
        {
          provider: "vercel-ai-gateway",
          id: "inclusionai/ling-3.1-flash-free",
          name: "Ling 3.1 Flash (Free)",
          input: ["text"],
          contextWindow: 262144,
          reasoning: true,
          available: true,
          tags: ["configured"],
        },
      ],
    });
  });

  it("uses the running Gateway without resolving unrelated local provider secrets", async () => {
    await expect(modelsListCommand({ json: true }, runtime() as never)).resolves.toBeUndefined();

    expect(mocks.loadModelsConfigWithSource).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "models.list",
        localPortOverride: 18789,
        params: { view: "default" },
      }),
    );
    expect(mocks.printModelTable).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          key: "vercel-ai-gateway/inclusionai/ling-3.1-flash-free",
          available: true,
          missing: false,
        }),
      ],
      expect.anything(),
      { json: true },
    );
  });

  it("refreshes discovery through the Gateway and filters provider rows locally", async () => {
    mocks.callGateway.mockResolvedValue({
      models: [
        {
          provider: "vercel-ai-gateway",
          id: "inclusionai/ling-3.1-flash-free",
          name: "Ling 3.1 Flash (Free)",
          available: true,
        },
        { provider: "openai", id: "gpt-5.4", name: "GPT 5.4", available: true },
      ],
    });

    await modelsListCommand(
      { json: true, refresh: true, provider: "vercel-ai-gateway" },
      runtime() as never,
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "models.list",
        timeoutMs: 210000,
        params: { view: "all", refresh: true },
      }),
    );
    const rows = mocks.printModelTable.mock.calls[0]?.[0] as Array<{ key: string }>;
    expect(rows.map((row) => row.key)).toEqual([
      "vercel-ai-gateway/inclusionai/ling-3.1-flash-free",
    ]);
  });
});

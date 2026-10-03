// Model load-config tests cover loading config used by model commands.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  getRuntimeConfigSourceSnapshot: vi.fn(),
  setRuntimeConfigSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getModelsCommandSecretTargetIds: vi.fn(),
  getModelsCommandSecretTargetsForProvider: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string) => provider.trim().toLowerCase()),
}));

vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: mocks.resolveProviderIdForAuth,
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot: mocks.setRuntimeConfigSnapshot,
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getModelsCommandSecretTargetIds: mocks.getModelsCommandSecretTargetIds,
  getModelsCommandSecretTargetsForProvider: mocks.getModelsCommandSecretTargetsForProvider,
}));

import { loadModelsConfig, loadModelsConfigWithSource } from "./load-config.js";

describe("models load-config", () => {
  const runtimeConfig = {
    models: { providers: { openai: { apiKey: "sk-runtime" } } }, // pragma: allowlist secret
  };
  const resolvedConfig = {
    models: { providers: { openai: { apiKey: "sk-resolved" } } }, // pragma: allowlist secret
  };
  const targetIds = new Set(["models.providers.*.apiKey"]);

  function mockResolvedConfigFlow(params: { sourceConfig: unknown; diagnostics: string[] }) {
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(params.sourceConfig);
    mocks.getModelsCommandSecretTargetIds.mockReturnValue(targetIds);
    mocks.getModelsCommandSecretTargetsForProvider.mockImplementation(
      ({
        providerId,
        equivalentProviderIds = [],
      }: {
        providerId: string;
        equivalentProviderIds?: string[];
      }) => ({
        targetIds,
        allowedPaths: new Set(
          (equivalentProviderIds.length > 0 ? equivalentProviderIds : [providerId]).map(
            (id) => "models.providers." + id + ".apiKey",
          ),
        ),
      }),
    );
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: params.diagnostics,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProviderIdForAuth.mockImplementation((provider: string) =>
      provider.trim().toLowerCase(),
    );
  });

  it("returns source+resolved configs and sets runtime snapshot", async () => {
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
          },
        },
      },
    };
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    mockResolvedConfigFlow({ sourceConfig, diagnostics: ["diag-one", "diag-two"] });

    const result = await loadModelsConfigWithSource({ commandName: "models list", runtime });

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: runtimeConfig,
      commandName: "models list",
      targetIds,
    });
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
    expect(runtime.error).toHaveBeenNthCalledWith(1, "[secrets] diag-one");
    expect(runtime.error).toHaveBeenNthCalledWith(2, "[secrets] diag-two");
    expect(runtime.log).not.toHaveBeenCalled();
    expect(result).toEqual({
      sourceConfig,
      resolvedConfig,
      diagnostics: ["diag-one", "diag-two"],
    });
  });

  it("scopes model secret resolution to the canonical selected provider", async () => {
    const sourceConfig = { models: { providers: {} } };
    mockResolvedConfigFlow({ sourceConfig, diagnostics: [] });

    await loadModelsConfigWithSource({
      commandName: "models auth list",
      provider: " OpenAI ",
    });

    expect(mocks.getModelsCommandSecretTargetsForProvider).toHaveBeenCalledWith({
      config: runtimeConfig,
      providerId: "openai",
      equivalentProviderIds: ["openai"],
    });
    expect(mocks.getModelsCommandSecretTargetIds).not.toHaveBeenCalled();
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: runtimeConfig,
      commandName: "models auth list",
      targetIds,
      allowedPaths: new Set(["models.providers.openai.apiKey"]),
    });
  });

  it("includes configured provider aliases that resolve to the selected auth provider", async () => {
    const aliasedRuntimeConfig = {
      models: {
        providers: {
          "openai-compatible": { apiKey: "sk-runtime" }, // pragma: allowlist secret
          google: { apiKey: "google-runtime" }, // pragma: allowlist secret
        },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(aliasedRuntimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(aliasedRuntimeConfig);
    mocks.resolveProviderIdForAuth.mockImplementation((provider: string) => {
      const normalized = provider.trim().toLowerCase();
      return normalized === "legacy-openai" || normalized === "openai-compatible"
        ? "openai"
        : normalized;
    });
    mocks.getModelsCommandSecretTargetsForProvider.mockImplementation(
      ({ equivalentProviderIds = [] }: { equivalentProviderIds?: string[] }) => ({
        targetIds,
        allowedPaths: new Set(
          equivalentProviderIds.map((id) => "models.providers." + id + ".apiKey"),
        ),
      }),
    );
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [],
    });

    await loadModelsConfigWithSource({
      commandName: "models auth list",
      provider: "legacy-openai",
    });

    expect(mocks.getModelsCommandSecretTargetsForProvider).toHaveBeenCalledWith({
      config: aliasedRuntimeConfig,
      providerId: "openai",
      equivalentProviderIds: ["openai-compatible"],
    });
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: aliasedRuntimeConfig,
      commandName: "models auth list",
      targetIds,
      allowedPaths: new Set(["models.providers.openai-compatible.apiKey"]),
    });
  });

  it("loadModelsConfig returns resolved config while preserving runtime snapshot behavior", async () => {
    const sourceConfig = { models: { providers: {} } };
    mockResolvedConfigFlow({ sourceConfig, diagnostics: [] });

    await expect(loadModelsConfig({ commandName: "models list" })).resolves.toBe(resolvedConfig);
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
  });

  it("can read core model config without loading plugin schemas", async () => {
    const sourceConfig = { models: { providers: {} } };
    mockResolvedConfigFlow({ sourceConfig, diagnostics: [] });

    await loadModelsConfig({ commandName: "models status", skipPluginValidation: true });

    expect(mocks.getRuntimeConfig).toHaveBeenCalledWith({ skipPluginValidation: true });
  });

  it("does not reread config when no source snapshot is pinned", async () => {
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(null);
    mocks.getModelsCommandSecretTargetIds.mockReturnValue(targetIds);
    mocks.getModelsCommandSecretTargetsForProvider.mockImplementation(
      ({
        providerId,
        equivalentProviderIds = [],
      }: {
        providerId: string;
        equivalentProviderIds?: string[];
      }) => ({
        targetIds,
        allowedPaths: new Set(
          (equivalentProviderIds.length > 0 ? equivalentProviderIds : [providerId]).map(
            (id) => "models.providers." + id + ".apiKey",
          ),
        ),
      }),
    );
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [],
    });

    const result = await loadModelsConfigWithSource({ commandName: "models list" });

    expect(result.sourceConfig).toBe(runtimeConfig);
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, runtimeConfig);
  });
});

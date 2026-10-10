import {
  ensureAuthProfileStoreMock,
  getApiKeyForModelMock,
  sessionCompactImpl,
} from "./compact.hooks.harness.js";

export function createPreparedCodexCompactionPlans(modelId = "gpt-5.5") {
  const modelRoute = {
    provider: "openai",
    modelId,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authRequirement: "api-key",
    requestTransportOverrides: "none",
    runtimePolicy: { compatibleIds: ["codex"] },
  } as const;
  const runtimeAuthPlan = {
    providerForAuth: "openai",
    modelId,
    authProfileProviderForAuth: "openai",
    harnessAuthProvider: "openai",
    selectedAuthMode: "api-key",
    modelRoute,
  } as const;
  return {
    modelRoute,
    runtimeAuthPlan,
    runtimePlan: {
      resolvedRef: {
        provider: "openai",
        modelId,
        modelApi: "openai-responses",
        harnessId: "codex",
      },
      auth: runtimeAuthPlan,
    } as never,
  };
}

export function configureExactAuthBindingCompactionFallback(): void {
  ensureAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      "openai:profile-a": { type: "api_key", provider: "openai", key: "profile-a-key" },
      "openai:profile-b": { type: "api_key", provider: "openai", key: "profile-b-key" },
    },
    order: { openai: ["openai:profile-a", "openai:profile-b"] },
  });
  getApiKeyForModelMock.mockImplementation(async (params?: { profileId?: string }) => ({
    apiKey: "test-key",
    mode: "api-key",
    source: `profile:${params?.profileId ?? "openai:profile-a"}`,
    profileId: params?.profileId ?? "openai:profile-a",
  }));
  sessionCompactImpl
    .mockRejectedValueOnce(
      Object.assign(new Error("primary compaction rate limited"), {
        status: 429,
        code: "rate_limit_exceeded",
      }),
    )
    .mockResolvedValueOnce({
      summary: "bound fallback summary",
      firstKeptEntryId: "entry-fallback",
      tokensBefore: 120,
      details: { ok: true },
    });
}

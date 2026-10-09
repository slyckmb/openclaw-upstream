import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "./failover-error.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

const manifestPlugins = [] as const;

function candidateRefs(params: Parameters<typeof resolveModelCandidateChain>[0]) {
  return resolveModelCandidateChain({ manifestPlugins, ...params }).map(
    ({ provider, model, authProfileId }) => ({
      provider,
      model,
      ...(authProfileId ? { authProfileId } : {}),
    }),
  );
}

describe("exact auth-bound model fallback", () => {
  it("preserves an exact auth binding on the requested candidate", () => {
    expect(
      candidateRefs({
        cfg: makeModelFallbackCfg(),
        provider: "openai",
        model: "gpt-5.6",
        requestedRouteResolution: "resolved",
        requestedAuthProfileId: "openai:primary",
        fallbacksOverride: [],
      }),
    ).toEqual([{ provider: "openai", model: "gpt-5.6", authProfileId: "openai:primary" }]);
  });

  it("preserves distinct auth-bound explicit fallback candidates", () => {
    expect(
      candidateRefs({
        cfg: makeModelFallbackCfg(),
        provider: "openai",
        model: "gpt-5.6",
        requestedRouteResolution: "resolved",
        fallbacksOverride: ["openai/gpt-5.6@openai:profile-a", "openai/gpt-5.6@openai:profile-b"],
      }),
    ).toEqual([
      { provider: "openai", model: "gpt-5.6" },
      { provider: "openai", model: "gpt-5.6", authProfileId: "openai:profile-a" },
      { provider: "openai", model: "gpt-5.6", authProfileId: "openai:profile-b" },
    ]);
  });

  it("advances between same-model candidates with distinct exact auth bindings", async () => {
    const run = vi.fn(
      async (_provider: string, _model: string, options?: { authProfileId?: string }) => {
        if (!options?.authProfileId) {
          throw new FailoverError("primary unavailable", {
            provider: "openai",
            model: "gpt-5.6",
            reason: "overloaded",
          });
        }
        if (options.authProfileId === "openai:profile-a") {
          throw new FailoverError("profile A unavailable", {
            provider: "openai",
            model: "gpt-5.6",
            reason: "auth",
            profileId: "openai:profile-a",
          });
        }
        return "profile-b-ok";
      },
    );

    const result = await runWithModelFallback({
      cfg: makeModelFallbackCfg(),
      provider: "openai",
      model: "gpt-5.6",
      requestedRouteResolution: "resolved",
      fallbacksOverride: ["openai/gpt-5.6@openai:profile-a", "openai/gpt-5.6@openai:profile-b"],
      manifestPlugins,
      skipAuthProfileRuntime: true,
      run,
    });

    expect(result.result).toBe("profile-b-ok");
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-5.6", { isFinalFallbackAttempt: false }],
      ["openai", "gpt-5.6", { authProfileId: "openai:profile-a", isFinalFallbackAttempt: false }],
      ["openai", "gpt-5.6", { authProfileId: "openai:profile-b", isFinalFallbackAttempt: true }],
    ]);
  });
});

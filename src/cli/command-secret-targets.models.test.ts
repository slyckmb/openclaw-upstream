// Model command secret-target tests cover provider-scoped model credential resolution.
import { describe, expect, it } from "vitest";
import { getModelsCommandSecretTargetsForProvider } from "./command-secret-targets.js";

describe("model command secret targets", () => {
  it("scopes to canonical and equivalent configured provider ids", () => {
    const scoped = getModelsCommandSecretTargetsForProvider({
      config: {
        models: {
          providers: {
            openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
            "openai-compatible": {
              apiKey: { source: "env", provider: "default", id: "OPENAI_COMPAT_API_KEY" },
            },
            google: { apiKey: { source: "env", provider: "default", id: "GOOGLE_API_KEY" } },
          },
        },
      } as never,
      providerId: "OpenAI",
      equivalentProviderIds: ["openai-compatible"],
    });

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["models.providers.openai.apiKey", "models.providers.openai-compatible.apiKey"]),
    );
  });
});

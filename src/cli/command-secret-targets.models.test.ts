// Model command secret-target tests cover provider-scoped model credential resolution.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getModelsCommandSecretTargetsForProvider } from "./command-secret-targets.js";

describe("model command secret targets", () => {
  it("scopes to canonical and equivalent configured provider ids", () => {
    const scoped = getModelsCommandSecretTargetsForProvider({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
            "openai-compatible": {
              baseUrl: "https://example.invalid/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_COMPAT_API_KEY" },
              models: [],
            },
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              apiKey: { source: "env", provider: "default", id: "GOOGLE_API_KEY" },
              models: [],
            },
          },
        },
      } satisfies OpenClawConfig,
      providerId: "OpenAI",
      equivalentProviderIds: ["openai-compatible"],
    });

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["models.providers.openai.apiKey", "models.providers.openai-compatible.apiKey"]),
    );
  });

  it("returns an empty allowed-path set for an empty provider id", () => {
    const config = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: { source: "env", provider: "default", id: "GOOGLE_API_KEY" },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const scoped = getModelsCommandSecretTargetsForProvider({ config, providerId: "" });

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(new Set());
  });
});

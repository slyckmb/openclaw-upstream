import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import * as providerTransportStream from "@openclaw/ai/transports";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "../../llm/stream.js";
import type { Model } from "../../llm/types.js";
import { createEmbeddedModelState } from "../embedded-agent-subscribe.model-state.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { resolveEmbeddedDispatchBindingSource } from "./run/binding-status.js";
import { resolveEmbeddedAgentStream as resolveStream } from "./stream-resolution.js";

vi.mock("@openclaw/ai/transports", async (importOriginal) => {
  const actual = await importOriginal<typeof providerTransportStream>();
  return {
    ...actual,
    createBoundaryAwareStreamFnForModel: vi.fn(actual.createBoundaryAwareStreamFnForModel),
  };
});
const llmRuntime = { ...defaultLlmRuntime, streamSimple };
function resolveEmbeddedAgentStream(
  params: Omit<Parameters<typeof resolveStream>[0], "llmRuntime">,
) {
  return resolveStream({ ...params, llmRuntime });
}

describe("physical binding observation", () => {
  const positive = { kind: "non-profile", authMode: "api-key", cliSession: "none" };
  function prepare(
    source: "direct-api-key" | "profile" | "unknown" = "direct-api-key",
    native = true,
  ) {
    const model = {
      provider: "fixture",
      id: "fixture-model",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
    } as Model<"openai-completions">;
    vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel).mockImplementationOnce(
      (_factoryModel, context) => {
        if (native) {
          context?.onNativeTransportSelected?.();
        }
        return (_model, _context, options) => {
          if (native) {
            (
              options as
                | { [providerTransportStream.nativeApiKeyObservation]?: () => void }
                | undefined
            )?.[providerTransportStream.nativeApiKeyObservation]?.();
          }
          const message = makeAssistantMessageFixture({
            provider: model.provider,
            model: model.id,
            stopReason: "stop",
          });
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return stream;
        };
      },
    );
    return resolveEmbeddedAgentStream({
      currentStreamFn: streamSimple,
      sessionId: "fixture-session",
      model,
      resolvedApiKey: "synthetic-private-key",
      bindingAuthSource: source,
    });
  }

  it.each([
    { source: "direct-api-key", native: true, expected: positive },
    { source: "profile", native: true, expected: { kind: "profile-bound" } },
    { source: "unknown", native: true, expected: { kind: "unknown" } },
    { source: "direct-api-key", native: false, expected: { kind: "unknown" } },
  ] as const)(
    "observes $source at the actual transport (native: $native)",
    async ({ source, native, expected }) => {
      const resolved = prepare(source, native);
      const stream = await resolved.streamFn(
        { provider: "fixture", id: "fixture-model", api: "openai-completions" } as never,
        { messages: [] },
      );
      const message = await stream.result();
      expect(resolved.getBindingStatus?.({ ...message })).toEqual(expected);
      expect(JSON.stringify(resolved.getBindingStatus?.(message))).not.toContain(
        "synthetic-private-key",
      );
    },
  );

  it("invalidates an earlier result as soon as another physical call starts", async () => {
    const resolved = prepare();
    const model = { provider: "fixture", id: "fixture-model", api: "openai-completions" } as never;
    const first = await (await resolved.streamFn(model, { messages: [] })).result();
    expect(resolved.getBindingStatus?.(first)).toEqual(positive);
    const second = await (await resolved.streamFn(model, { messages: [] })).result();
    expect(resolved.getBindingStatus?.(first)).toEqual({ kind: "unknown" });
    expect(resolved.getBindingStatus?.({ ...second })).toEqual(positive);
    expect(resolved.getBindingStatus?.(undefined)).toEqual({ kind: "unknown" });
  });

  it("preserves physical correlation through the canonical completed-assistant snapshots", async () => {
    const resolved = prepare();
    const stream = await resolved.streamFn(
      { provider: "fixture", id: "fixture-model", api: "openai-completions" } as never,
      { messages: [] },
    );
    const message = await stream.result();
    const state = createEmbeddedModelState(
      { runId: "fixture-run" } as never,
      { warn: vi.fn() } as never,
    );
    state.captureModelEvent({ type: "message_end", message });
    expect(resolved.getBindingStatus?.(state.getCurrentAttemptAssistant())).toEqual(positive);
  });

  it.each([
    { name: "resolved direct key", expected: "direct-api-key", changes: {} },
    { name: "missing source", expected: "unknown", changes: { credentialSource: undefined } },
    {
      name: "prepared direct but resolved profile",
      expected: "unknown",
      changes: {
        apiKeyInfo: {
          apiKey: "fixture-key",
          profileId: "fixture-profile",
          mode: "api-key",
          source: "profile:fixture-profile",
        },
      },
    },
    {
      name: "profile winner",
      expected: "profile",
      changes: {
        credentialSource: { kind: "profile" },
        authProfileId: "fixture-profile",
        apiKeyInfo: {
          apiKey: "fixture-key",
          profileId: "fixture-profile",
          mode: "api-key",
          source: "profile:fixture-profile",
        },
      },
    },
    {
      name: "changed credential",
      expected: "unknown",
      changes: { resolvedApiKey: "different-fixture-key" },
    },
    {
      name: "SDK auth",
      expected: "unknown",
      changes: { apiKeyInfo: { mode: "aws-sdk", source: "aws-sdk" } },
    },
    {
      name: "opaque runtime replacement",
      expected: "unknown",
      changes: { runtimeAuthReplaced: true },
    },
    {
      name: "plugin transport",
      expected: "unknown",
      changes: { pluginHarnessOwnsTransport: true },
    },
    {
      name: "unsupported mode",
      expected: "unknown",
      changes: { apiKeyInfo: { apiKey: "fixture-key", mode: "oauth", source: "fixture" } },
    },
  ])("captures $name without re-resolving auth", ({ changes, expected }) => {
    expect(
      resolveEmbeddedDispatchBindingSource({
        credentialSource: {
          kind: "direct",
          evidence: "provider-config",
          authorization: "declared",
        },
        authProfileId: undefined,
        apiKeyInfo: { apiKey: "fixture-key", mode: "api-key", source: "fixture-config" },
        resolvedApiKey: "fixture-key",
        runtimeAuthReplaced: false,
        pluginHarnessOwnsTransport: false,
        ...changes,
      } as never),
    ).toBe(expected);
  });
});

import { writeFile } from "node:fs/promises";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { nativeApiKeyObservation } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import type { Message, Model } from "../../../llm/types.js";
import { runAgentLoop } from "../../../plugin-sdk/agent-core.js";
import { createAssistantMessageEventStream } from "../../../plugin-sdk/llm.js";
import { createEmbeddedModelState } from "../../embedded-agent-subscribe.model-state.js";
import { attachModelProviderRequestTransport } from "../../provider-request-config.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import {
  resolveEmbeddedDispatchBindingSource,
  createEmbeddedBindingObserver,
} from "./binding-status.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

describe("offline producer binding envelopes", () => {
  it.each([
    { name: "model headers", model: { headers: { Authorization: "synthetic-override" } } },
    { name: "different API", model: { api: "anthropic-messages" } },
    {
      name: "request auth",
      request: { auth: { mode: "authorization-bearer", token: "synthetic-override" } },
    },
    { name: "request headers", request: { headers: { Authorization: "synthetic-override" } } },
    { name: "caller headers", options: { headers: { Authorization: "synthetic-override" } } },
    { name: "different key", options: { apiKey: "synthetic-other-key" } },
    { name: "caller profile", options: { authProfileId: "synthetic-profile" } },
  ])("keeps $name evidence unknown", async (input) => {
    const base = { id: "fixture-model", provider: "fixture", api: "openai-completions" } as Model;
    const model = attachModelProviderRequestTransport(
      { ...base, ...input.model },
      input.request as never,
    );
    const observer = createEmbeddedBindingObserver();
    const stream = observer.observe(
      (_model, _context, options) => {
        (options as { [nativeApiKeyObservation]?: () => void } | undefined)?.[
          nativeApiKeyObservation
        ]?.();
        const message = makeAssistantMessageFixture({ stopReason: "stop" });
        const events = createAssistantMessageEventStream();
        events.push({ type: "done", reason: "stop", message });
        events.end(message);
        return events;
      },
      { source: "direct-api-key", resolvedApiKey: "synthetic-key", model: base },
    );
    const message = await (
      await stream(model, { messages: [] }, { apiKey: "synthetic-key", ...input.options })
    ).result();
    expect(observer.getBindingStatus(message)).toEqual({ kind: "unknown" });
  });

  it("carries real native HTTP execution through the agent loop and terminal assembly", async () => {
    const previousHost = getAiTransportHost();
    const envelopes: Record<string, unknown> = {};
    const key = "synthetic-binding-fixture-key";
    const model: Model<"openai-completions"> = {
      id: "fixture-model",
      name: "Offline fixture",
      provider: "fixture",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 128,
    };
    const requests: Request[] = [];
    configureAiTransportHost({
      ...previousHost,
      buildModelFetch: () => async (input, init) => {
        requests.push(new Request(input, init));
        const chunk = {
          id: "fixture-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Offline fixture complete." },
              finish_reason: "stop",
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const offlineHost = getAiTransportHost();
    try {
      for (const [name, source, expected] of [
        ["non-profile", "direct", { kind: "non-profile", authMode: "api-key", cliSession: "none" }],
        ["profile-bound", "profile", { kind: "profile-bound" }],
        ["unknown", "missing", { kind: "unknown" }],
        ["conflicting-header", "direct", { kind: "unknown" }],
      ] as const) {
        const conflict = name === "conflicting-header";
        configureAiTransportHost({
          ...offlineHost,
          resolveProviderRequestHeaders: conflict
            ? () => ({ Authorization: "Bearer synthetic-header-override" })
            : previousHost.resolveProviderRequestHeaders,
        });
        const authProfileId = source === "profile" ? "synthetic-profile" : undefined;
        const bindingAuthSource = resolveEmbeddedDispatchBindingSource({
          credentialSource:
            source === "missing"
              ? undefined
              : source === "profile"
                ? { kind: "profile" }
                : { kind: "direct", evidence: "provider-config", authorization: "declared" },
          authProfileId,
          apiKeyInfo: {
            apiKey: key,
            mode: "api-key",
            profileId: authProfileId,
            source: source === "profile" ? "profile:synthetic-profile" : "synthetic-config",
          },
          resolvedApiKey: key,
          runtimeAuthReplaced: false,
          pluginHarnessOwnsTransport: false,
        });
        const transport = resolveEmbeddedAgentStream({
          model,
          llmRuntime: defaultLlmRuntime,
          currentStreamFn: defaultLlmRuntime.streamSimple,
          sessionId: "fixture-session",
          resolvedApiKey: key,
          bindingAuthSource,
        });
        const state = createEmbeddedModelState(
          { runId: "fixture-run" } as never,
          { warn: vi.fn() } as never,
        );
        await runAgentLoop(
          [{ role: "user", content: "Offline fixture", timestamp: 1 }],
          { systemPrompt: "Offline fixture", messages: [], tools: [] },
          { model, convertToLlm: (messages) => messages as Message[] },
          (event) => {
            if (
              event.type === "message_start" ||
              event.type === "message_update" ||
              event.type === "message_end"
            ) {
              state.captureModelEvent(event);
            }
          },
          undefined,
          transport.streamFn,
        );
        const assistant = state.getCurrentAttemptAssistant();
        expect(assistant?.stopReason, assistant?.errorMessage).toBe("stop");
        const bindingStatus = transport.getBindingStatus?.(assistant);
        expect(bindingStatus).toEqual(expected);
        const attempt = makeEmbeddedRunnerAttempt({
          agentHarnessId: "openclaw",
          bindingStatus,
          assistantTexts: ["Offline fixture complete."],
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          lastAssistant: assistant,
        });
        const terminal = await resolveEmbeddedRunTerminal(
          makeTerminalInput({
            attempt,
            authProfileId,
            startedAtMs: Date.now(),
            provider: model.provider,
            modelId: model.id,
            agentMeta: { sessionId: "fixture-session", provider: model.provider, model: model.id },
            payloadsWithToolMedia: [{ text: "Offline fixture complete." }],
          }),
        );
        expect(terminal.action).toBe("complete");
        if (terminal.action !== "complete") {
          throw new Error("expected terminal envelope");
        }
        expect(terminal.result.meta.agentMeta?.bindingStatus).toEqual(expected);
        // Public projection from real assembly; exclude timing and unrelated execution diagnostics.
        envelopes[name] = {
          payloads: terminal.result.payloads,
          meta: { agentMeta: terminal.result.meta.agentMeta },
        };
      }
      expect(requests).toHaveLength(4);
      for (const [index, request] of requests.entries()) {
        expect(request.url).toBe("https://example.invalid/v1/chat/completions");
        expect(request.headers.get("authorization")).toBe(
          index === 3 ? "Bearer synthetic-header-override" : `Bearer ${key}`,
        );
      }
      const serialized = JSON.stringify(envelopes, null, 2) + "\n";
      for (const forbidden of [
        key,
        "synthetic-profile",
        "synthetic-config",
        "profile:",
        "SecretRef",
        "synthetic-header-override",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      // Optional test artifact only; no product environment flag or runtime state.
      if (process.env.OPENCLAW_BINDING_FIXTURE_OUTPUT) {
        await writeFile(process.env.OPENCLAW_BINDING_FIXTURE_OUTPUT, serialized);
      }
    } finally {
      configureAiTransportHost(previousHost);
    }
  });
});

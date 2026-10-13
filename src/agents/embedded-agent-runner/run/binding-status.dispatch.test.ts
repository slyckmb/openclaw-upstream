import { writeFile } from "node:fs/promises";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { Message, Model } from "../../../llm/types.js";
import { runAgentLoop } from "../../../plugin-sdk/agent-core.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { createEmbeddedModelState } from "../../embedded-agent-subscribe.model-state.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { completeEmbeddedAttemptResult, createAttemptCarryover } from "./attempt-result.js";
import { createResultFixture } from "./attempt-result.test-support.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

const nativeAttempt = vi.hoisted(() => ({ run: vi.fn() }));
// Replace only heavyweight session/bootstrap setup. Dispatch, harness selection,
// native request/agent loop, result assembly, backend and terminal owners are real.
vi.mock("./attempt.js", () => ({ runEmbeddedAttempt: nativeAttempt.run }));
vi.mock("../../runtime-plan/build.js", () => ({
  buildAgentRuntimePlan: ({
    provider,
    modelId,
    preparedAuthPlan,
  }: {
    provider: string;
    modelId: string;
    preparedAuthPlan: unknown;
  }) => ({ resolvedRef: { provider, modelId }, auth: preparedAuthPlan }),
}));
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

type Source = "direct" | "profile" | "missing";
const model: Model<"openai-completions"> = {
  id: "fixture-model",
  name: "Offline dispatch fixture",
  provider: "fixture",
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 128,
};

it.each([
  { earlier: "direct", winner: "profile", expected: { kind: "profile-bound" } },
  {
    earlier: "profile",
    winner: "direct",
    expected: { kind: "non-profile", authMode: "api-key", cliSession: "none" },
  },
  { earlier: "direct", winner: "missing", expected: { kind: "unknown" } },
  { earlier: "direct", winner: "direct", noWinnerAssistant: true, expected: { kind: "unknown" } },
] as const)(
  "dispatches $earlier then $winner without earlier-only binding carryover ($noWinnerAssistant)",
  async (scenario) => {
    await withOpenClawTestState({ label: "binding-dispatch" }, async (state) => {
      const agentId = "main";
      const sandboxSessionKey = undefined;
      const oneShotCliRun = undefined;
      const runtimePluginToolGrant = undefined;
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {} },
          defaults: { skipBootstrap: true, sandbox: { mode: "off" as const } },
        },
        session: { scope: "global" as const },
      };
      const runId = "binding-dispatch-fixture";
      const admission = prepareAgentRunAdmission({
        cfg: config,
        facts: {
          runId,
          agentId,
          ingress: { kind: "system", boundary: "binding-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("embedded", "binding-test");
      setActivePluginRegistry(createEmptyPluginRegistry());
      const params = {
        admittedRunContext,
        agentId,
        config,
        runId,
        sessionId: "binding-session",
        sessionKey: "global",
        sandboxSessionKey,
        workspaceDir: state.workspaceDir,
        sessionFile: state.path("binding-session.jsonl"),
        prompt: "Offline binding fixture",
        timeoutMs: 5000,
        disableTools: true,
        runtimePluginToolGrant,
        oneShotCliRun,
      };
      let lifecycleGeneration = getAgentEventLifecycleGeneration();
      const laneController = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => lifecycleGeneration,
        getParams: () => params,
        globalLane: "binding-global",
        sessionLane: "binding-session",
        initialQueuedLifecycleGeneration: lifecycleGeneration,
        setLifecycleGeneration: (value) => {
          lifecycleGeneration = value;
        },
        setParams: () => {},
      });
      const authProfileStore = { version: 1, profiles: {} };
      let runtime: ReturnType<
        Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0]["preparedRuntime"]["snapshot"]
      >;
      const requests: Request[] = [];
      const previousHost = getAiTransportHost();
      configureAiTransportHost({
        ...previousHost,
        buildModelFetch: () => async (request, init) => {
          requests.push(new Request(request, init));
          const chunk = {
            id: "binding-completion",
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
      nativeAttempt.run.mockReset();
      nativeAttempt.run.mockImplementation(async (attemptParams: EmbeddedRunAttemptParams) => {
        const transport = resolveEmbeddedAgentStream({
          model: attemptParams.model,
          llmRuntime: defaultLlmRuntime,
          currentStreamFn: defaultLlmRuntime.streamSimple,
          sessionId: attemptParams.sessionId,
          resolvedApiKey: attemptParams.resolvedApiKey,
          bindingAuthSource: attemptParams.bindingAuthSource,
        });
        const modelState = createEmbeddedModelState({ runId } as never, { warn: vi.fn() } as never);
        await runAgentLoop(
          [{ role: "user", content: "Offline binding fixture", timestamp: 1 }],
          { systemPrompt: "Offline fixture", messages: [], tools: [] },
          { model: attemptParams.model, convertToLlm: (messages) => messages as Message[] },
          (event) => {
            if (
              event.type === "message_start" ||
              event.type === "message_update" ||
              event.type === "message_end"
            ) {
              modelState.captureModelEvent(event);
            }
          },
          undefined,
          transport.streamFn,
        );
        const assistant = modelState.getCurrentAttemptAssistant();
        expect(assistant?.stopReason, assistant?.errorMessage).toBe("stop");
        const suppressCompleted =
          "noWinnerAssistant" in scenario && nativeAttempt.run.mock.calls.length === 2;
        const fixture = createResultFixture({
          currentAttemptCompletedAssistant: suppressCompleted ? undefined : assistant,
          assistantTexts: ["Offline fixture complete."],
          getBindingStatus: transport.getBindingStatus,
        });
        fixture.input.attempt = {
          ...fixture.input.attempt,
          ...attemptParams,
        } as typeof fixture.input.attempt;
        fixture.settled.currentAttemptAssistant = assistant;
        fixture.settled.lastAssistant = assistant;
        fixture.prompt.messagesSnapshot = assistant ? [assistant] : [];
        return completeEmbeddedAttemptResult(
          fixture.input as never,
          fixture.settled,
          fixture.prompt,
        );
      });
      const input = {
        runInput: {
          runParams: params,
          provider: "fixture",
          modelId: "fixture-model",
          workspaceResolution: { agentId, workspaceDir: state.workspaceDir },
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(agentId),
          isCanonicalWorkspace: true,
          resolvedSessionKey: "global",
          resolvedToolResultFormat: "markdown",
          startedAtMs: Date.now(),
          startupStages: { mark: vi.fn() },
          emitStartupStageSummary: vi.fn(),
          lifecycleGeneration,
          laneController,
          progressController: {
            resolveAttemptFastModeParam: () => false,
            maybeAnnounceFastModeAutoOff: vi.fn(),
            notifyExecutionPhase: vi.fn(),
            notifyRunProgress: vi.fn(),
            notifyToolResult: vi.fn(),
            notifyAgentEvent: vi.fn(),
          },
        },
        preparedRuntime: {
          requestedModelId: "fixture-model",
          nativeModelOwned: false,
          attemptAuthProfileStore: authProfileStore,
          resolveRunAttemptAuthProfileStore: () => authProfileStore,
          snapshot: () => runtime,
        },
        sessionPromptState: {
          sessionId: `${agentId}-global`,
          sessionFile: "global",
          sessionTarget: { agentId, sessionId: `${agentId}-global`, sessionKey: "global" },
          activePrompt: { persisted: false, internal: false },
          onUserMessagePersisted: vi.fn(),
          settleOwnedTranscriptProjection: vi.fn(),
          suppressNextUserMessagePersistence: false,
        },
        terminalRetryState: { beforeFinalizeRevisionAttempts: 0 },
        provider: "fixture",
        modelId: "fixture-model",
        replayState: { replayInvalid: false, hadPotentialSideEffects: false },
        startupStagesEmitted: false,
        bootstrapPromptWarningSignaturesSeen: [],
        resolveRuntimeFallbackReason: () => null,
        observeToolOutcome: vi.fn(),
        isTurnTainted: () => false,
        allocateToolOutcomeOrdinal: () => 1,
        getPostCompactionAbortError: () => undefined,
        setPostCompactionAbortController() {},
        clearPostCompactionAbortController() {},
      } as unknown as Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0];

      const carryover = createAttemptCarryover();
      const attempts: EmbeddedRunAttemptResult[] = [];
      try {
        for (const [index, source] of [scenario.earlier, scenario.winner].entries()) {
          const kind: Source = source;
          const key = `synthetic-dispatch-key-${index}`;
          const profileId = kind === "profile" ? `synthetic-profile-${index}` : undefined;
          runtime = {
            agentHarness: { id: "openclaw" },
            pluginHarnessOwnsTransport: false,
            pluginHarnessOwnsAuthBootstrap: false,
            effectiveModel: model,
            thinkLevel: "off",
            apiKeyInfo: {
              apiKey: key,
              mode: "api-key",
              profileId,
              source: profileId ? `profile:${profileId}` : "synthetic-config",
            },
            runtimeAuthState: null,
            lastProfileId: profileId,
            activePreparedAuthPlan: {
              providerForAuth: "fixture",
              authProfileProviderForAuth: "fixture",
              credentialSource:
                kind === "missing"
                  ? undefined
                  : kind === "profile"
                    ? { kind: "profile" }
                    : { kind: "direct", evidence: "provider-config", authorization: "declared" },
            },
            providerRuntimeHandle: { provider: "fixture" },
          } as unknown as typeof runtime;
          const dispatched = await prepareAndDispatchEmbeddedRunAttempt(input);
          const result = dispatched.dispatchedAttempt.rawAttempt;
          carryover.apply(result);
          attempts.push(result);
          expect(result.agentHarnessId).toBe("openclaw");
          expect(dispatched.dispatchedAttempt.preparedAttempt.bindingAuthSource).toBe(
            kind === "missing" ? "unknown" : kind === "profile" ? "profile" : "direct-api-key",
          );
          expect(requests[index]?.headers.get("authorization")).toBe(`Bearer ${key}`);
        }
        expect(nativeAttempt.run).toHaveBeenCalledTimes(2);
        const winner = attempts[1];
        const resolved = await resolveEmbeddedRunTerminal(
          makeTerminalInput({
            attempt: winner,
            authProfileId: runtime!.lastProfileId,
            agentMeta: {
              sessionId: "binding-session",
              provider: model.provider,
              model: model.id,
              bindingStatus: attempts[0]?.bindingStatus,
            },
            payloadsWithToolMedia: [{ text: "Offline fixture complete." }],
          }),
        );
        expect(resolved.action).toBe("complete");
        if (resolved.action !== "complete") {
          throw new Error("expected terminal envelope");
        }
        expect(resolved.result.meta.agentMeta?.bindingStatus).toEqual(scenario.expected);
        const projection = {
          payloads: resolved.result.payloads,
          meta: { agentMeta: resolved.result.meta.agentMeta },
        };
        expect(JSON.stringify(projection)).not.toMatch(
          /synthetic-dispatch-key|synthetic-profile|synthetic-config/,
        );
        if (
          process.env.OPENCLAW_BINDING_DISPATCH_FIXTURE_OUTPUT &&
          scenario.winner === "direct" &&
          !("noWinnerAssistant" in scenario)
        ) {
          await writeFile(
            process.env.OPENCLAW_BINDING_DISPATCH_FIXTURE_OUTPUT,
            JSON.stringify(projection, null, 2) + "\n",
          );
        }
      } finally {
        configureAiTransportHost(previousHost);
        admission.close();
        nativeAttempt.run.mockReset();
      }
    });
  },
);

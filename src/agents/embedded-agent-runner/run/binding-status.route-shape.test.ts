import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import "../../../llm/ai-transport-host.js";
import { streamSimple } from "../../../llm/stream.js";
import type { Model } from "../../../llm/types.js";
import { looksLikeSecretSentinel, mintSecretSentinel } from "../../../secrets/sentinel.js";
import { getApiKeyForModelCore } from "../../model-auth-model.js";
import { prepareAgentRuntimeAuth } from "../../runtime-plan/prepare-auth.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { resolveEmbeddedDispatchBindingSource } from "./binding-status.js";

// Only the final network call is replaced. Secret resolution, sentinel egress
// swapping, the native transport and the producer observer are all production code.
const network = vi.hoisted(() => ({ guarded: vi.fn() }));
vi.mock("../../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: network.guarded,
  withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => params,
}));
vi.mock("../../provider-local-service.js", () => ({
  ensureModelProviderLocalService: vi.fn(async () => undefined),
}));

// Non-secret shape of the deployed ClinePass route: provider-level
// openai-completions, env SecretRef apiKey, no auth profile, unlisted model.
const ENV_ID = "SYNTHETIC_CLINEPASS_KEY";
const PLAINTEXT = "synthetic-route-shape-credential"; // pragma: allowlist secret
const config = {
  models: {
    providers: {
      clinepass: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        apiKey: { source: "env", provider: "default", id: ENV_ID },
        models: [{ id: "listed-model", name: "Listed" }],
      },
    },
  },
} as unknown as OpenClawConfig;
const model = {
  provider: "clinepass",
  id: "unlisted/route",
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 128,
} as unknown as Model<"openai-completions">;
const unknown = { kind: "unknown" };
const positive = { kind: "non-profile", authMode: "api-key", cliSession: "none" };
const sseBody = () =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;

let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_ID];
  process.env[ENV_ID] = PLAINTEXT;
  network.guarded.mockReset().mockImplementation(async () => ({
    response: new Response(sseBody(), { headers: { "content-type": "text/event-stream" } }),
    finalUrl: "https://example.invalid/v1/chat/completions",
    release: vi.fn(async () => undefined),
  }));
});
afterEach(() => {
  if (previousEnv === undefined) {
    delete process.env[ENV_ID];
  } else {
    process.env[ENV_ID] = previousEnv;
  }
});

async function resolveRoute() {
  const store = { version: 1 as const, profiles: {} };
  const prepared = prepareAgentRuntimeAuth({
    provider: model.provider,
    modelId: model.id,
    modelApi: model.api,
    config,
    env: process.env,
    authProfileStore: store,
  });
  const apiKeyInfo = await getApiKeyForModelCore({
    model: model as never,
    cfg: config,
    store,
    secretSentinels: true,
  });
  return { credentialSource: prepared.plan.credentialSource, apiKeyInfo };
}

it("attests a SecretRef-backed route through real secret egress without emitting any credential", async () => {
  const { credentialSource, apiKeyInfo } = await resolveRoute();
  // Provenance gates all pass; the only distinguishing fact is the sentinel key.
  expect(credentialSource).toMatchObject({
    kind: "direct",
    evidence: "environment",
    authorization: "declared",
  });
  expect(apiKeyInfo).toMatchObject({ mode: "api-key" });
  expect(apiKeyInfo.profileId).toBeUndefined();
  expect(apiKeyInfo.source?.startsWith("profile:")).toBe(false);
  expect(looksLikeSecretSentinel(apiKeyInfo.apiKey ?? "")).toBe(true);

  const source = resolveEmbeddedDispatchBindingSource({
    credentialSource,
    apiKeyInfo,
    resolvedApiKey: apiKeyInfo.apiKey,
    runtimeAuthReplaced: false,
    pluginHarnessOwnsTransport: false,
  });
  expect(source).toBe("direct-api-key");

  const resolved = resolveEmbeddedAgentStream({
    currentStreamFn: streamSimple,
    llmRuntime: { ...defaultLlmRuntime, streamSimple },
    sessionId: "route-shape-session",
    model,
    resolvedApiKey: apiKeyInfo.apiKey,
    bindingAuthSource: source,
  });
  const stream = await resolved.streamFn(model, {
    messages: [{ role: "user", content: "ping", timestamp: 1 }],
  });
  const message = await stream.result();
  expect(message.stopReason, message.errorMessage).toBe("stop");

  // The winning physical request carried exactly the corresponding resolved
  // credential: swapped at the production egress, never a sentinel or a stub value.
  expect(network.guarded).toHaveBeenCalledTimes(1);
  const sent = new Headers(network.guarded.mock.calls[0]?.[0]?.init?.headers);
  expect(sent.get("authorization")).toBe(`Bearer ${PLAINTEXT}`);
  expect(sent.get("authorization")).not.toContain("oc-sent-v2");

  const status = resolved.getBindingStatus?.(message);
  expect(status).toEqual(positive);
  const emitted = JSON.stringify({ status, source });
  expect(emitted).not.toContain(PLAINTEXT);
  expect(emitted).not.toContain("oc-sent-v2");
  expect(emitted).not.toContain(ENV_ID);
});

it.each([
  { label: "ambient", authorization: "ambient" as const, expected: unknown },
  { label: "declared", authorization: "declared" as const, expected: positive },
])(
  "verifies the real physical request without overstating $label plaintext key authorization",
  async ({ authorization, expected }) => {
    const { credentialSource, apiKeyInfo } = await resolveRoute();
    const source = resolveEmbeddedDispatchBindingSource({
      credentialSource: {
        ...(credentialSource as object),
        authorization,
      } as never,
      apiKeyInfo: { ...apiKeyInfo, apiKey: PLAINTEXT },
      resolvedApiKey: PLAINTEXT,
      runtimeAuthReplaced: false,
      pluginHarnessOwnsTransport: false,
    });
    expect(source).toBe(authorization === "declared" ? "direct-api-key" : "unknown");

    const resolved = resolveEmbeddedAgentStream({
      currentStreamFn: streamSimple,
      llmRuntime: { ...defaultLlmRuntime, streamSimple },
      sessionId: `route-shape-plaintext-${authorization}`,
      model,
      resolvedApiKey: PLAINTEXT,
      bindingAuthSource: source,
    });
    const message = await (
      await resolved.streamFn(model, {
        messages: [{ role: "user", content: "ping", timestamp: 1 }],
      })
    ).result();
    expect(message.stopReason, message.errorMessage).toBe("stop");
    expect(network.guarded).toHaveBeenCalledTimes(1);
    const sent = new Headers(network.guarded.mock.calls[0]?.[0]?.init?.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${PLAINTEXT}`);
    expect(resolved.getBindingStatus?.(message)).toEqual(expected);
  },
);

it("stays unknown when the sentinel was never registered and egress refuses it", async () => {
  const forged = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
  const { credentialSource, apiKeyInfo } = await resolveRoute();
  const forgedInfo = { ...apiKeyInfo, apiKey: forged };
  expect(
    resolveEmbeddedDispatchBindingSource({
      credentialSource,
      apiKeyInfo: forgedInfo,
      resolvedApiKey: forged,
      runtimeAuthReplaced: false,
      pluginHarnessOwnsTransport: false,
    }),
  ).toBe("unknown");

  // Even if a caller forced it through, egress refuses to send and nothing is attested.
  const resolved = resolveEmbeddedAgentStream({
    currentStreamFn: streamSimple,
    llmRuntime: { ...defaultLlmRuntime, streamSimple },
    sessionId: "route-shape-forged",
    model,
    resolvedApiKey: forged,
    bindingAuthSource: "direct-api-key",
  });
  const message = await (
    await resolved.streamFn(model, { messages: [{ role: "user", content: "ping", timestamp: 1 }] })
  ).result();
  expect(network.guarded).not.toHaveBeenCalled();
  expect(resolved.getBindingStatus?.(message)).toEqual(unknown);
});

it.each([
  { label: "runtime-replaced auth", patch: { runtimeAuthReplaced: true } },
  { label: "plugin-owned transport", patch: { pluginHarnessOwnsTransport: true } },
  { label: "ambient (undeclared) credential", patch: { ambient: true } },
  { label: "runtime-resolved evidence", patch: { evidence: "runtime" as const } },
  { label: "a selected profile id", patch: { authProfileId: "synthetic-profile" } },
  { label: "mismatched resolved key", patch: { mismatch: true } },
])("stays unknown for $label", async ({ patch }) => {
  const { credentialSource, apiKeyInfo } = await resolveRoute();
  const p = patch as Record<string, unknown>;
  const source = resolveEmbeddedDispatchBindingSource({
    credentialSource: {
      ...(credentialSource as object),
      ...(p.ambient ? { authorization: "ambient" } : {}),
      ...(p.evidence ? { evidence: p.evidence } : {}),
    } as never,
    apiKeyInfo,
    resolvedApiKey: p.mismatch
      ? mintSecretSentinel("a-different-synthetic-key", { label: "other" })
      : apiKeyInfo.apiKey,
    authProfileId: p.authProfileId as string | undefined,
    runtimeAuthReplaced: p.runtimeAuthReplaced === true,
    pluginHarnessOwnsTransport: p.pluginHarnessOwnsTransport === true,
  });
  expect(source).toBe("unknown");
});

import { nativeApiKeyObservation } from "@openclaw/ai/transports";
import type { AssistantMessage } from "../../../llm/types.js";
import { looksLikeSecretSentinel } from "../../../secrets/sentinel.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { getModelProviderRequestTransport } from "../../provider-request-config.js";
import type { AgentRuntimeCredentialSource } from "../../runtime-plan/types.js";
import type { StreamFn } from "../../runtime/index.js";
import type { AgentBindingStatus } from "../types.js";

export type EmbeddedDispatchBindingSource = "direct-api-key" | "profile" | "unknown";

/** Correlates the resolved credential with the key handed to this dispatch. */
export function resolveEmbeddedDispatchBindingSource(input: {
  credentialSource: AgentRuntimeCredentialSource | undefined;
  authProfileId?: string;
  apiKeyInfo: ResolvedProviderAuth | null;
  resolvedApiKey?: string;
  runtimeAuthReplaced: boolean;
  pluginHarnessOwnsTransport: boolean;
}): EmbeddedDispatchBindingSource {
  const auth = input.apiKeyInfo;
  if (
    input.pluginHarnessOwnsTransport ||
    input.runtimeAuthReplaced ||
    !auth ||
    !input.resolvedApiKey?.trim() ||
    looksLikeSecretSentinel(input.resolvedApiKey) ||
    auth.apiKey?.trim() !== input.resolvedApiKey.trim()
  ) {
    return "unknown";
  }
  if (input.credentialSource?.kind === "profile") {
    return input.authProfileId && auth.profileId === input.authProfileId ? "profile" : "unknown";
  }
  if (
    input.credentialSource?.kind !== "direct" ||
    (input.credentialSource.evidence !== "environment" &&
      input.credentialSource.evidence !== "provider-config") ||
    auth.mode !== "api-key" ||
    input.authProfileId ||
    auth.profileId ||
    !auth.source ||
    auth.source.startsWith("profile:")
  ) {
    return "unknown";
  }
  return "direct-api-key";
}

// Symbols survive the agent loop's object spreads, but never serialize into a
// transcript or envelope. Only explicit snapshot copies retain the call token.
const physicalBinding = Symbol("embedded-physical-binding");
type BindingToken = { status: AgentBindingStatus; native: { observed: boolean } };
type ObservedAssistant = AssistantMessage & { [physicalBinding]?: BindingToken };

export function copyEmbeddedBindingObservation<T extends AssistantMessage>(
  source: T,
  target: T,
): T {
  // SAFETY: this optional private symbol is only attached by this module's physical-call owner.
  const token = (source as ObservedAssistant)[physicalBinding];
  if (token) {
    Object.assign(target, { [physicalBinding]: token });
  }
  return target;
}

/** One transport owner, with no cross-attempt carryover. */
export function createEmbeddedBindingObserver() {
  let latest: BindingToken | undefined;
  return {
    observe(
      stream: StreamFn,
      input: {
        source: EmbeddedDispatchBindingSource | undefined;
        resolvedApiKey?: string;
        model: Parameters<StreamFn>[0];
      },
    ): StreamFn {
      return async (model, context, options) => {
        const request = getModelProviderRequestTransport(model);
        // This initial proof covers the native Chat transport's explicit key
        // branch. Other transports can select OAuth or plugin turn-state auth
        // internally and require their own physical-auth observation.
        const supported = model.api === "openai-completions";
        const matched =
          supported &&
          !request?.auth &&
          !Object.keys(request?.headers ?? {}).length &&
          Boolean(input.resolvedApiKey?.trim()) &&
          options?.apiKey === input.resolvedApiKey?.trim() &&
          model.provider === input.model.provider &&
          model.id === input.model.id &&
          model.api === input.model.api &&
          !Object.keys(model.headers ?? {}).length &&
          !Object.keys(options?.headers ?? {}).length &&
          !(
            input.source === "direct-api-key" &&
            // SAFETY: authProfileId is an optional embedded extension to standard stream options.
            (options as { authProfileId?: string } | undefined)?.authProfileId
          );
        const token: BindingToken = Object.freeze({
          native: { observed: false },
          status: !matched
            ? { kind: "unknown" }
            : input.source === "direct-api-key"
              ? { kind: "non-profile", authMode: "api-key", cliSession: "none" }
              : input.source === "profile"
                ? { kind: "profile-bound" }
                : { kind: "unknown" },
        });
        latest = token;
        const observedOptions = {
          ...options,
          [nativeApiKeyObservation]: () => {
            token.native.observed = true;
          },
        };
        const response = await stream(model, context, observedOptions);
        return new Proxy(response, {
          get(target, property, receiver) {
            if (property === "result") {
              return async () => {
                const message = await target.result();
                // Preserve native result identity and its other private provenance.
                return Object.assign(message, { [physicalBinding]: token });
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
    },
    getBindingStatus(this: void, assistant: AssistantMessage | undefined): AgentBindingStatus {
      // SAFETY: arbitrary assistants lack the optional private symbol; only this module's call owner adds it.
      const token = (assistant as ObservedAssistant | undefined)?.[physicalBinding];
      return token &&
        token === latest &&
        token.native.observed &&
        assistant &&
        (assistant.stopReason === "stop" ||
          assistant.stopReason === "toolUse" ||
          assistant.stopReason === "length")
        ? { ...token.status }
        : { kind: "unknown" };
    },
  };
}

import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";

type HarnessAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileProvider: string;
  authProfileMode?: string;
};

type AttemptAuthProfileSelection = {
  id: string;
  source?: "auto" | "user";
};

export function resolveAttemptAuthProfileSelection(params: {
  candidateAuthProfileId?: string;
  configuredAuthProfileId?: string;
  sessionEntry?: SessionEntry;
}): AttemptAuthProfileSelection | undefined {
  const candidateAuthProfileId = params.candidateAuthProfileId?.trim();
  if (candidateAuthProfileId) {
    return { id: candidateAuthProfileId, source: "user" };
  }
  const sessionAuthProfileId = params.sessionEntry?.authProfileOverride?.trim();
  const sessionAuthProfileSource = resolveCollapsedSessionAuthPinSource(params.sessionEntry);
  if (sessionAuthProfileId && sessionAuthProfileSource !== "auto") {
    return { id: sessionAuthProfileId, source: sessionAuthProfileSource };
  }
  const configuredAuthProfileId = params.configuredAuthProfileId?.trim();
  if (configuredAuthProfileId) {
    return { id: configuredAuthProfileId, source: "user" };
  }
  return sessionAuthProfileId
    ? { id: sessionAuthProfileId, source: sessionAuthProfileSource }
    : undefined;
}

export function resolveHarnessAuthProfileSelection(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  authProfileProvider: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user";
  harnessId?: string;
  harnessRuntime?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  providerAuthAliasesEnabled?: boolean;
  allowHarnessAuthProfileForwarding: boolean;
}): HarnessAuthProfileSelection {
  const sessionAuthProfileId = params.sessionAuthProfileId?.trim();
  if (sessionAuthProfileId) {
    const credential = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
      externalCliProfileIds: [sessionAuthProfileId],
    }).profiles[sessionAuthProfileId];
    return {
      authProfileId: sessionAuthProfileId,
      authProfileIdSource: params.sessionAuthProfileSource,
      authProfileProvider: credential?.provider ?? params.authProfileProvider,
      authProfileMode: credential?.type,
    };
  }

  if (!params.allowHarnessAuthProfileForwarding) {
    return { authProfileProvider: params.authProfileProvider };
  }

  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: params.authProfileProvider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.providerAuthAliasesEnabled,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessRuntime,
    allowHarnessAuthProfileForwarding: params.allowHarnessAuthProfileForwarding,
  });
  const harnessAuthProvider = runtimeAuthPlan.harnessAuthProvider;
  if (!harnessAuthProvider) {
    return { authProfileProvider: params.authProfileProvider };
  }

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    externalCliProviderIds: [harnessAuthProvider],
  });
  const authProfileId = resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider: harnessAuthProvider,
  })[0];

  return authProfileId
    ? {
        authProfileId,
        authProfileIdSource: "auto",
        authProfileProvider: harnessAuthProvider,
      }
    : { authProfileProvider: params.authProfileProvider };
}

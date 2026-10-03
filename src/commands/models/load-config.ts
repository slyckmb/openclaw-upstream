/** Config loader for model commands with command-scoped secret resolution. */
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import {
  getModelsCommandSecretTargetIds,
  getModelsCommandSecretTargetsForProvider,
} from "../../cli/command-secret-targets.js";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

/** Source and resolved config pair returned by model command config loading. */
type LoadedModelsConfig = {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  diagnostics: string[];
};

/** Loads config, resolves model command secrets, and preserves the source snapshot. */
export async function loadModelsConfigWithSource(params: {
  commandName: string;
  runtime?: RuntimeEnv;
  skipPluginValidation?: boolean;
  provider?: string;
}): Promise<LoadedModelsConfig> {
  const runtimeConfig = getRuntimeConfig(
    params.skipPluginValidation ? { skipPluginValidation: true } : undefined,
  );
  const pinnedSourceConfig = getRuntimeConfigSourceSnapshot();
  const sourceConfig = pinnedSourceConfig ?? runtimeConfig;
  const provider = params.provider?.trim()
    ? resolveProviderIdForAuth(params.provider, { config: runtimeConfig })
    : undefined;
  const equivalentProviderIds = provider
    ? Object.keys(runtimeConfig.models?.providers ?? {}).filter(
        (configuredProviderId) =>
          resolveProviderIdForAuth(configuredProviderId, { config: runtimeConfig }) === provider,
      )
    : [];
  const scopedTargets = provider
    ? getModelsCommandSecretTargetsForProvider({
        config: runtimeConfig,
        providerId: provider,
        equivalentProviderIds,
      })
    : { targetIds: getModelsCommandSecretTargetIds() };
  const { resolvedConfig, diagnostics } = await resolveCommandConfigWithSecrets({
    config: runtimeConfig,
    commandName: params.commandName,
    targetIds: scopedTargets.targetIds,
    ...("allowedPaths" in scopedTargets ? { allowedPaths: scopedTargets.allowedPaths } : {}),
    runtime: params.runtime,
  });
  // Keep the original source snapshot pinned so later config writes do not
  // accidentally serialize already-resolved secret values.
  setRuntimeConfigSnapshot(resolvedConfig, sourceConfig);
  return {
    sourceConfig,
    resolvedConfig,
    diagnostics,
  };
}

/** Loads the resolved model command config when callers do not need source metadata. */
export async function loadModelsConfig(params: {
  commandName: string;
  runtime?: RuntimeEnv;
  skipPluginValidation?: boolean;
  provider?: string;
}): Promise<OpenClawConfig> {
  return (await loadModelsConfigWithSource(params)).resolvedConfig;
}

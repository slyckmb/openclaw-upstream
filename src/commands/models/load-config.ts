/** Config loader for model commands with command-scoped secret resolution. */
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import {
  getModelsCommandSecretTargetIds,
  getModelsCommandSecretTargetIdsForProvider,
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
  const targetIds = params.provider
    ? getModelsCommandSecretTargetIdsForProvider(params.provider)
    : getModelsCommandSecretTargetIds();
  const { resolvedConfig, diagnostics } = await resolveCommandConfigWithSecrets({
    config: runtimeConfig,
    commandName: params.commandName,
    targetIds,
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

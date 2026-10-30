import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isProtectedFloorPresent } from "./protected-floor.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";

/**
 * Fail closed before a surface that runs host code outside the protected sandbox.
 * A protected session is always refused. On a host with an operator floor, a
 * sessionless run is refused because it cannot be attributed to either class.
 */
export function assertHostProcessAdmitted(
  cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined,
  surface: string,
): void {
  if (sessionKey) {
    const runtime = resolveSandboxRuntimeStatus({ cfg, sessionKey });
    if (runtime.sandboxRequired) {
      throw new Error(`Protected execution denied: ${surface} is not an attested capability`);
    }
    return;
  }
  if (isProtectedFloorPresent()) {
    throw new Error(`Protected execution denied: sessionless ${surface} on a protected host`);
  }
}

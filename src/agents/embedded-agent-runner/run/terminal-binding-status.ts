import { classifyAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import type { EmbeddedAgentMeta } from "../types.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Sanitizes only the completed physical winner; prepared/previous metadata cannot attest it. */
export function projectEmbeddedTerminalBinding(
  input: {
    agentMeta: EmbeddedAgentMeta;
    attempt: EmbeddedRunAttemptResult;
    terminalState: EmbeddedRunTerminalState;
    authProfileId?: string;
    pluginHarnessOwnsTransport: boolean;
    pluginHarnessOwnsAuthBootstrap: boolean;
  },
  error: unknown,
): EmbeddedAgentMeta {
  const unsuccessful =
    Boolean(error) ||
    classifyAgentRunTerminalOutcome(input.terminalState.outcome) !== "success" ||
    input.attempt.yieldDetected ||
    !input.attempt.currentAttemptCompletedAssistant ||
    input.pluginHarnessOwnsTransport ||
    input.pluginHarnessOwnsAuthBootstrap;
  const status = input.attempt.bindingStatus;
  return {
    ...input.agentMeta,
    bindingStatus: unsuccessful
      ? { kind: "unknown" }
      : status?.kind === "profile-bound"
        ? { kind: "profile-bound" }
        : status?.kind === "non-profile" &&
            status.authMode === "api-key" &&
            status.cliSession === "none" &&
            !input.authProfileId &&
            !input.agentMeta.cliSessionBinding
          ? { kind: "non-profile", authMode: "api-key", cliSession: "none" }
          : { kind: "unknown" },
  };
}

import { describe, expect, it } from "vitest";
import { resolveAttemptAuthProfileSelection } from "./attempt-auth-selection.js";

describe("resolveAttemptAuthProfileSelection", () => {
  it("locks an exact fallback-candidate profile over session and configured profiles", () => {
    expect(
      resolveAttemptAuthProfileSelection({
        candidateAuthProfileId: "openai:candidate",
        configuredAuthProfileId: "openai:configured",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          authProfileOverride: "openai:session-choice",
          authProfileOverrideSource: "user",
        },
      }),
    ).toEqual({ id: "openai:candidate", source: "user" });
  });

  it("preserves existing session/configured precedence when no candidate binding exists", () => {
    expect(
      resolveAttemptAuthProfileSelection({
        configuredAuthProfileId: "openai:configured",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          authProfileOverride: "openai:session-choice",
          authProfileOverrideSource: "user",
        },
      }),
    ).toEqual({ id: "openai:session-choice", source: "user" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCliAgent } from "./cli-runner.js";

const protectedRuntime = vi.hoisted(() => vi.fn(() => ({ sandboxRequired: false })));
const floorPresent = vi.hoisted(() => vi.fn(() => false));
const prepareCliRunContext = vi.hoisted(() => vi.fn());

vi.mock("./sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: protectedRuntime,
}));

vi.mock("./sandbox/protected-floor.js", () => ({
  isProtectedFloorPresent: floorPresent,
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext,
}));

function cliParams(overrides: Record<string, unknown>): Parameters<typeof runCliAgent>[0] {
  return {
    sessionId: "cli-admission",
    provider: "claude-cli",
    model: "sonnet-4.6",
    prompt: "hello",
    timeoutMs: 1000,
    runId: "cli-admission-run",
    ...overrides,
  } as unknown as Parameters<typeof runCliAgent>[0];
}

describe("CLI backend process admission (A1 and gap 3)", () => {
  beforeEach(() => {
    protectedRuntime.mockReset();
    protectedRuntime.mockReturnValue({ sandboxRequired: false });
    floorPresent.mockReset();
    floorPresent.mockReturnValue(false);
    prepareCliRunContext.mockReset();
    prepareCliRunContext.mockRejectedValue(new Error("sentinel-prepare-reached"));
  });

  it("refuses a protected session before hooks, preparation, or any host process", async () => {
    protectedRuntime.mockReturnValue({ sandboxRequired: true });
    await expect(runCliAgent(cliParams({ sessionKey: "agent:main:guest" }))).rejects.toThrow(
      "Protected execution denied: CLI backend process is not an attested capability",
    );
    expect(prepareCliRunContext).not.toHaveBeenCalled();
  });

  it("refuses sessionless CLI runs on a host with an operator floor", async () => {
    floorPresent.mockReturnValue(true);
    await expect(runCliAgent(cliParams({}))).rejects.toThrow(
      "Protected execution denied: sessionless CLI backend process on a protected host",
    );
    expect(prepareCliRunContext).not.toHaveBeenCalled();
  });

  it("admits an unprotected session and reaches preparation", async () => {
    await expect(runCliAgent(cliParams({ sessionKey: "agent:main:main" }))).rejects.toThrow(
      "sentinel-prepare-reached",
    );
    expect(prepareCliRunContext).toHaveBeenCalledOnce();
  });
});

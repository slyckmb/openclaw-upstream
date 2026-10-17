import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const runtimeStatus = vi.hoisted(() => vi.fn());

vi.mock("./sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: runtimeStatus,
}));

import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("protected session MCP registration", () => {
  afterEach(() => runtimeStatus.mockReset());

  it("rejects protected agent MCP initialization before any data directory or transport setup", () => {
    const fakeHome = tempDirs.make("pr25-mcp-home-");
    const workspaceDir = path.join(fakeHome, "would-be-plugin-data");
    runtimeStatus.mockReturnValue({ sandboxRequired: true });
    expect(() =>
      createSessionMcpRuntime({
        sessionId: "protected-mcp",
        sessionKey: "agent:main:main",
        workspaceDir,
      }),
    ).toThrow(/Protected execution denied: MCP server setup/);
    expect(runtimeStatus).toHaveBeenCalledOnce();
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it("does not classify sessionless maintenance as a protected agent by guesswork", () => {
    // The trusted Gateway administrator path is separate from agent attribution.
    // This test proves only that no unsupported session identity is invented.
    runtimeStatus.mockReturnValue({ sandboxRequired: true });
    expect(() =>
      createSessionMcpRuntime({
        sessionId: "maintenance",
        workspaceDir: tempDirs.make("pr25-mcp-maintenance-"),
        cfg: { mcp: { servers: {} } },
      }),
    ).not.toThrow();
    expect(runtimeStatus).not.toHaveBeenCalled();
  });
});

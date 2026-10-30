import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import { resolveSandboxContext } from "./sandbox/context.js";

// Required provisioning needs a verified operator floor (B1). These cases are split out
// of the main sandbox context suite so that suite stays under its line limit.
vi.mock("./sandbox/protected-floor.js", () => ({ assertProtectedFloorActive: () => {} }));

let sandboxFixtureRoot = "";
let sandboxFixtureCount = 0;

async function createSandboxFixtureDir(prefix: string): Promise<string> {
  const dir = path.join(sandboxFixtureRoot, `${prefix}-${sandboxFixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  sandboxFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-protected-"));
});

afterAll(async () => {
  await fs.rm(sandboxFixtureRoot, { recursive: true, force: true });
});

describe("resolveSandboxContext protected provisioning", () => {
  it("provisions and marks a required sandbox when the agent sandbox mode is off", async () => {
    const sessionKey = "agent:main:guest";
    const workspaceDir = await createSandboxFixtureDir("required-sandbox");
    const storePath = path.join(workspaceDir, "agents", "main", "sessions", "sessions.json");
    const entry = {
      sessionId: "guest-session",
      updatedAt: 1,
      sandbox: "required" as const,
      createdActor: { type: "human" as const, id: "guest-principal" },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const backendFactory = vi.fn(async () => ({
      id: "required-backend",
      runtimeId: "required-runtime",
      runtimeLabel: "Required Runtime",
      workdir: "/workspace",
      buildExecSpec: async () => ({
        argv: ["required-backend", "exec"],
        env: {},
        stdinMode: "pipe-closed" as const,
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    const restore = registerSandboxBackend("required-backend", backendFactory);
    const warnLogs = createWarnLogCapture("openclaw-required-sandbox-workspace");

    try {
      const sandbox = await resolveSandboxContext({
        config: {
          session: { store: storePath },
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
                backend: "required-backend",
                scope: "shared",
                workspaceAccess: "rw",
                prune: { idleHours: 0, maxAgeDays: 0 },
              },
            },
            list: [{ id: "main" }],
          },
        },
        sessionKey,
        workspaceDir,
      });

      expect(sandbox).toMatchObject({
        required: true,
        workspaceAccess: "ro",
      });
      expect(sandbox?.workspaceDir).not.toBe(workspaceDir);
      expect(await warnLogs.findText("workspaceAccess")).toMatch(/rw.*ro/i);
      expect(backendFactory).toHaveBeenCalledWith(
        expect.objectContaining({ cfg: expect.objectContaining({ scope: "agent" }) }),
      );
    } finally {
      warnLogs.cleanup();
      restore();
    }
  }, 15_000);

  it("fails closed when a required sandbox cannot be provisioned with agent sandbox mode off", async () => {
    const sessionKey = "agent:main:guest";
    const workspaceDir = await createSandboxFixtureDir("required-sandbox-failure");
    const storePath = path.join(workspaceDir, "agents", "main", "sessions", "sessions.json");
    const entry = {
      sessionId: "guest-session",
      updatedAt: 1,
      sandbox: "required" as const,
      createdActor: { type: "human" as const, id: "guest-principal" },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const backendFailure = new Error("Required sandbox backend unavailable");
    const restore = registerSandboxBackend("required-broken-backend", async () => {
      throw backendFailure;
    });

    try {
      await expect(
        resolveSandboxContext({
          config: {
            session: { store: storePath },
            agents: {
              defaults: {
                sandbox: {
                  mode: "off",
                  backend: "required-broken-backend",
                  scope: "session",
                  workspaceAccess: "rw",
                  prune: { idleHours: 0, maxAgeDays: 0 },
                },
              },
              list: [{ id: "main" }],
            },
          },
          sessionKey,
          workspaceDir,
        }),
      ).rejects.toMatchObject({
        code: "sandbox_provisioning",
        backendId: "required-broken-backend",
        message: "Required sandbox backend unavailable",
        cause: backendFailure,
      });
    } finally {
      restore();
    }
  }, 15_000);
});

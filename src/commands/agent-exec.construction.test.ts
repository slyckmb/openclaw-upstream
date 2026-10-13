import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as cliBackends from "../plugins/cli-backends.runtime.js";
import * as processSupervisor from "../process/supervisor/index.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { withEnvAsync } from "../test-utils/env.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent exec command composition", () => {
  it("rejects an undeclared rooted CLI before constructing a private-input process", async () => {
    const root = tempDirs.make("openclaw-agent-exec-service-construction-");
    const pidPath = path.join(root, "command.pid");
    const configPath = path.join(root, "openclaw.json");
    const createSecretData = vi.fn(() => Buffer.alloc(8 * 1024 * 1024, 97));
    // CLI execution must fail closed before preparing a secret or spawning a process.
    // The real blocked-secret construction/cleanup contract remains tested in
    // src/process/supervisor/adapters/child.service-lifecycle.test.ts.
    vi.spyOn(cliBackends, "resolveRuntimeCliBackends").mockReturnValue([
      {
        id: "construction-cli",
        pluginId: "construction-test",
        config: {
          command: process.execPath,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
          ],
          input: "stdin",
          output: "text",
        },
        prepareExecution: () => ({
          beforeExecution: async () => {},
          secretInput: {
            fd: 3,
            fingerprint: "synthetic-construction",
            createData: createSecretData,
          },
        }),
      },
    ]);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "construction-cli/model-a" },
            thinkingDefault: "off",
          },
        },
      }),
      "utf8",
    );

    const supervisor = createProcessSupervisor();
    const spawn = vi.spyOn(supervisor, "spawn");
    vi.spyOn(processSupervisor, "getProcessSupervisor").mockReturnValue(supervisor);

    try {
      const completed = await withEnvAsync(
        {
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_SERVICE_MARKER: "openclaw",
        },
        () =>
          agentExecCommand(
            "probe",
            { config: configPath, cwd: root, timeout: "1", json: true },
            createTestRuntime(),
          ),
      );

      expect(completed.exitCode).toBe(1);
      expect(completed.envelope).toMatchObject({
        ok: false,
        status: "error",
        error: {
          message: expect.stringContaining(
            "does not declare instruction isolation with exact tools",
          ),
        },
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(createSecretData).not.toHaveBeenCalled();
      await expect(fs.stat(pidPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    }
  });
});

import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { EmbeddedAgentRunResult } from "../src/agents/embedded-agent-runner/types.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it("attests the winning SecretRef-env key through the compiled Gateway diagnostic wrappers", async () => {
  const credential = "synthetic-binding-gateway-key"; // pragma: allowlist secret
  const requests: { authorization?: string; traceparent?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      traceparent: request.headers.traceparent as string | undefined,
    });
    request.resume();
    const chunk = {
      id: "binding-gateway-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "ACK" }, finish_reason: "stop" }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("binding fixture server did not bind");
  }
  let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
  try {
    instance = await createOpenClawTestInstance({
      name: "gateway-binding-status",
      config: {
        plugins: { enabled: false },
        tools: { profile: "minimal" },
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            skipBootstrap: true,
            skills: [],
            heartbeat: { every: "0m" },
            model: { primary: "binding-fixture/fixture-model" },
          },
        },
        models: {
          mode: "replace",
          providers: {
            "binding-fixture": {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: { source: "env", provider: "default", id: "SYNTHETIC_BINDING_KEY" },
              models: [
                {
                  id: "fixture-model",
                  name: "Binding fixture",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 32_000,
                  maxTokens: 128,
                  compat: { supportsStore: false },
                },
              ],
            },
          },
        },
      },
      env: {
        SYNTHETIC_BINDING_KEY: credential,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    await instance.startGateway();
    const command = await instance.cli([
      "agent",
      "--agent",
      "main",
      "--model",
      "binding-fixture/fixture-model",
      "--message",
      "Reply with exactly ACK",
      "--thinking",
      "off",
      "--json",
    ]);
    expect(command.code, command.stderr).toBe(0);
    const envelope = JSON.parse(command.stdout) as { result: EmbeddedAgentRunResult };
    expect(envelope.result.payloads).toContainEqual(expect.objectContaining({ text: "ACK" }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe(`Bearer ${credential}`);
    // The actual diagnostic owner injects this header; a bare transport test misses it.
    expect(requests[0]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u);
    expect(envelope.result.meta.agentMeta?.bindingStatus).toEqual({
      kind: "non-profile",
      authMode: "api-key",
      cliSession: "none",
    });
    expect(command.stdout).not.toContain(credential);
    expect(command.stdout).not.toContain("oc-sent-v2.");
    expect(command.stdout).not.toContain("SYNTHETIC_BINDING_KEY");
  } finally {
    try {
      await instance?.cleanup();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}, 90_000);

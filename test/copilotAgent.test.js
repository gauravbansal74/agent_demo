import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Conversation } from "../src/agent.js";
import { CopilotAgent } from "../src/copilotAgent.js";
import { MCPHub } from "../src/mcpHub.js";
import { mockConfig } from "./fakes.js";

let hub;
before(async () => {
  hub = await new MCPHub(mockConfig()).connect();
});
after(() => hub.close());

/** Stands in for CopilotClient: one turn calls a tool through its handler, streams text, then goes idle. */
class FakeCopilotClient {
  configs = [];
  async start() {}
  async stop() {}
  async createSession(config) {
    this.configs.push(config);
    const handlers = {};
    return {
      on: (type, fn) => {
        handlers[type] = fn;
        return () => delete handlers[type];
      },
      send: async () => {
        const tool = config.tools.find((t) => t.name === "policies__list_policies");
        handlers["tool.execution_start"]({ data: { toolName: tool.name } });
        // The model tries to look at another customer's policies.
        this.toolResult = await tool.handler({ customer_id: "C1002" });
        handlers["assistant.message_delta"]({ data: { deltaContent: "You have " } });
        handlers["assistant.message_delta"]({ data: { deltaContent: "2 policies." } });
        handlers["session.idle"]({ data: {} });
        return "msg_1";
      },
      disconnect: async () => {},
    };
  }
}

test("Copilot agent streams the same UI events and keeps customer scoping", async () => {
  const client = new FakeCopilotClient();
  const agent = new CopilotAgent(hub, client);
  const events = [];
  for await (const e of agent.reply(new Conversation("C1001"), "What policies do I have?")) events.push(e);

  assert.deepEqual(events, [
    { type: "tool", name: "policies__list_policies", label: "List policies" },
    { type: "text", text: "You have " },
    { type: "text", text: "2 policies." },
    { type: "done" },
  ]);
  // The handler went through MCPHub, so C1001's records came back, not C1002's.
  assert.match(client.toolResult.textResultForLlm, /LIF-2014-558201/);
  assert.doesNotMatch(client.toolResult.textResultForLlm, /LIF-2019-771045/);
});

test("Copilot session is locked down to the insurance tools", async () => {
  const client = new FakeCopilotClient();
  const agent = new CopilotAgent(hub, client);
  for await (const _ of agent.reply(new Conversation("C1001"), "hi"));
  const config = client.configs[0];

  assert.deepEqual(config.availableTools.toArray(), new (await import("@github/copilot-sdk")).ToolSet().addCustom("*").toArray());
  assert.equal(config.systemMessage.mode, "replace");
  assert.equal(config.onPermissionRequest({ kind: "shell" }).kind, "reject");
  assert.ok(config.tools.every((t) => !("customer_id" in t.parameters.properties)));
});

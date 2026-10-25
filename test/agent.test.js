import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { Conversation, InsuranceAgent } from "../src/agent.js";
import { MCPHub } from "../src/mcpHub.js";
import { FakeClient, message, mockConfig } from "./fakes.js";

let hub;
before(async () => {
  hub = await new MCPHub(mockConfig()).connect();
});
after(() => hub.close());

async function run(agent, convo, text) {
  const events = [];
  for await (const e of agent.reply(convo, text)) events.push(e);
  return events;
}

test("tool loop calls MCP and returns the answer", async () => {
  const client = new FakeClient([
    message([{ type: "tool_use", id: "tu_1", name: "claims__get_claims_summary", input: {} }], "tool_use"),
    message([{ type: "text", text: "One claim needs a referral letter." }], "end_turn"),
  ]);
  const convo = new Conversation("C1001");
  const events = await run(new InsuranceAgent(hub, client), convo, "Do any claims need something from me?");

  assert.deepEqual(events, [
    { type: "tool", name: "claims__get_claims_summary", label: "Get claims summary" },
    { type: "text", text: "One claim needs a referral letter." },
    { type: "done" },
  ]);
  // The second request carried the MCP result back to Claude, scoped to C1001.
  const toolResult = client.requests[1].messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, "tu_1");
  assert.match(toolResult.content, /CLM-2026-005930/);
  assert.deepEqual(convo.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
});

test("refusal is reported to the customer", async () => {
  const events = await run(new InsuranceAgent(hub, new FakeClient([message([], "refusal")])), new Conversation("C1001"), "hi");
  assert.equal(events[0].type, "error");
  assert.deepEqual(events.at(-1), { type: "done" });
});

test("real SDK sends the expected request", async () => {
  let captured;
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (url, init) => {
      captured = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(run(new InsuranceAgent(hub, client), new Conversation("C1001"), "hi"), Anthropic.BadRequestError);
  assert.equal(captured.body.model, "claude-opus-5-5");
  assert.equal(captured.body.fallbacks, "default");
  assert.deepEqual(captured.body.output_config, { effort: "medium" });
  assert.equal(captured.headers.get("anthropic-beta"), "server-side-fallback-2026-07-01");
  assert.ok(captured.body.tools.every((t) => !("customer_id" in t.input_schema.properties)));
});


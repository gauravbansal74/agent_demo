import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MCPHub, loadConfig } from "../src/mcpHub.js";

let hub;
before(async () => {
  hub = await new MCPHub(loadConfig("mcp-servers.json")).connect();
});
after(() => hub.close());

test("discovers tools from both servers", () => {
  const names = hub.claudeTools().map((t) => t.name);
  assert.ok(names.includes("policies__list_policies"));
  assert.ok(names.includes("claims__get_claim_status"));
});

test("customer_id is hidden from Claude", () => {
  for (const t of hub.claudeTools()) {
    assert.ok(!("customer_id" in t.input_schema.properties), t.name);
    assert.ok(!(t.input_schema.required ?? []).includes("customer_id"), t.name);
  }
});

test("customer_id is injected and cannot be overridden by the model", async () => {
  // The model tries to ask for C1002's policies while C1001 is signed in.
  const { text, isError } = await hub.call("policies__list_policies", { customer_id: "C1002" }, "C1001");
  assert.equal(isError, false);
  const numbers = JSON.parse(text).result.map((p) => p.policy_number).sort();
  assert.deepEqual(numbers, ["ACC-2020-445210", "HLT-2018-110934", "LIF-2014-558201"]);
});

test("another customer's claim is not found", async () => {
  const { text } = await hub.call("claims__get_claim_status", { claim_id: "CLM-2026-006102" }, "C1001");
  assert.match(text, /not found/);
});

test("unknown tool is an error", async () => {
  assert.equal((await hub.call("nope", {}, "C1001")).isError, true);
});

test("${VAR} values are read from the environment", () => {
  process.env.POLICY_MCP_URL = "https://mcp.example.com/policies";
  const file = path.join(tmpdir(), `mcp-config-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ servers: { p: { transport: "streamable_http", url: "${POLICY_MCP_URL}" } } }));
  assert.equal(loadConfig(file).servers.p.url, "https://mcp.example.com/policies");
});

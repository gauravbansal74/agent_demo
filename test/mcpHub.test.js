import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MCPHub, loadConfig } from "../src/mcpHub.js";
import { mockConfig } from "./fakes.js";

let hub;
before(async () => {
  hub = await new MCPHub(mockConfig()).connect();
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

test("file tools work with other argument names, and only get the arguments they have", async () => {
  const files = await new MCPHub({
    customerIdArgument: "clientId",
    uploadArguments: { content: "fileData" },
    servers: { docs: { transport: "stdio", command: process.execPath, args: ["test/fixtures/file-echo-server.js"] } },
  }).connect();
  try {
    assert.deepEqual(files.fileTools(), ["docs__upload_document"]);
    const schema = files.claudeTools()[0].input_schema;
    assert.deepEqual(Object.keys(schema.properties).sort(), ["claimNumber", "upload_id"]);
    const uploads = new Map([["UPL-1", { name: "x.png", type: "image/png", data: Buffer.from("png") }]]);
    const { text } = await files.call("docs__upload_document", { claimNumber: "CLM-1", upload_id: "UPL-1" }, "0028319228", uploads);
    // No file_name or mime_type, which this tool doesn't have.
    assert.deepEqual(JSON.parse(text), { claimNumber: "CLM-1", clientId: "0028319228", fileData: Buffer.from("png").toString("base64") });
  } finally {
    await files.close();
  }
});

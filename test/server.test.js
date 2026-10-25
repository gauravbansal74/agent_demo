import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { InsuranceAgent } from "../src/agent.js";
import { MCPHub, loadConfig } from "../src/mcpHub.js";
import { createApp } from "../src/server.js";
import { FakeClient, message } from "./fakes.js";

let hub, server, base, agent;
before(async () => {
  hub = await new MCPHub(loadConfig("mcp-servers.mock.json")).connect();
  agent = new InsuranceAgent(hub, new FakeClient([]));
  server = createApp(agent).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.close();
  await hub.close();
});

test("config lists demo customers", async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.brand_name, "Sunlife");
  assert.equal(cfg.brand_tagline, "Making life brighter");
  // No official artwork in public/brand/ yet, so the placeholder is used.
  assert.equal(cfg.brand_logo, null);
  assert.equal(cfg.brand_mark, "/static/logo-placeholder.svg");
  assert.ok(cfg.demo_customers.some((c) => c.customer_id === "C1001" && c.name === "Priya Sharma"));
});

test("chat streams events", async () => {
  agent.client = new FakeClient([message([{ type: "text", text: "You have 2 policies." }], "end_turn")]);
  const post = (url, body) =>
    fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const { session_id } = await (await post("/api/session", { customer_id: "C1001" })).json();
  const text = await (await post("/api/chat", { session_id, message: "What policies do I have?" })).text();
  const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(events, [{ type: "text", text: "You have 2 policies." }, { type: "done" }]);
});

test("chat requires a session", async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "bogus", message: "hi" }),
  });
  assert.equal(res.status, 401);
});

test("index page is served", async () => {
  assert.match(await (await fetch(`${base}/`)).text(), /Customer Assistant/);
});

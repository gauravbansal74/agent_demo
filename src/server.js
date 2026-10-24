// Express server: chat API (Server-Sent Events) plus the static chat UI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { BRAND_NAME, Conversation, InsuranceAgent, PROVIDER } from "./agent.js";
import { MCPHub, loadConfig } from "./mcpHub.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_CONFIG = process.env.MCP_CONFIG ?? path.join(ROOT, "mcp-servers.json");
// Demo sign-in list. Replace the demo sign-in with your identity provider in production.
const DEMO_CUSTOMERS = path.join(ROOT, "data", "customers.json");

const hasToolUse = (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use");

export function createApp(agent) {
  // In-memory sessions: fine for a demo, use Redis or a database for multiple instances.
  const sessions = new Map();
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/config", (req, res) => {
    const customers = existsSync(DEMO_CUSTOMERS)
      ? JSON.parse(readFileSync(DEMO_CUSTOMERS, "utf8")).map((c) => ({
          customer_id: c.customer_id,
          name: `${c.first_name} ${c.last_name}`,
        }))
      : [];
    res.json({ brand_name: BRAND_NAME, demo_customers: customers });
  });

  // Demo sign-in: starts a chat session bound to one customer id.
  app.post("/api/session", (req, res) => {
    const customerId = String(req.body?.customer_id ?? "").trim();
    if (!customerId || customerId.length > 64) return res.status(422).json({ error: "customer_id is required" });
    const sessionId = randomBytes(24).toString("base64url");
    sessions.set(sessionId, new Conversation(customerId));
    res.json({ session_id: sessionId });
  });

  app.delete("/api/session/:id", async (req, res) => {
    const convo = sessions.get(req.params.id);
    sessions.delete(req.params.id);
    if (convo) await agent.endConversation?.(convo);
    res.json({ ok: true });
  });

  // Lists the tools discovered from the connected MCP servers (for debugging).
  app.get("/api/tools", (req, res) => {
    res.json([...agent.hub.tools.values()].map((t) => ({ name: t.claudeTool.name, server: t.server, customer_scoped: t.scoped })));
  });

  app.post("/api/chat", async (req, res) => {
    const convo = sessions.get(req.body?.session_id);
    if (!convo) return res.status(401).json({ error: "Session expired. Please sign in again." });
    const message = String(req.body?.message ?? "").trim();
    if (!message || message.length > 4000) return res.status(422).json({ error: "message must be 1-4000 characters" });

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      for await (const event of agent.reply(convo, message)) send(event);
    } catch (err) {
      console.error("chat turn failed", err);
      // Drop the half-finished turn so the conversation stays valid for the next message.
      while (convo.messages.length) {
        const last = convo.messages.at(-1);
        if (last.role === "assistant" && !hasToolUse(last)) break;
        convo.messages.pop();
      }
      send({ type: "error", text: "Something went wrong on our side. Please try again." });
      send({ type: "done" });
    }
    res.end();
  });

  app.use("/static", express.static(path.join(ROOT, "public")));
  app.get("/", (req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hub = await new MCPHub(loadConfig(MCP_CONFIG)).connect();
  let agent;
  if (PROVIDER === "copilot") {
    const { CopilotAgent } = await import("./copilotAgent.js");
    agent = new CopilotAgent(hub);
  } else {
    agent = new InsuranceAgent(hub);
  }
  const port = Number(process.env.PORT ?? 3000);
  const server = createApp(agent).listen(port, () =>
    console.log(`${BRAND_NAME} assistant on http://localhost:${port} (LLM provider: ${PROVIDER})`),
  );
  const shutdown = () =>
    server.close(async () => {
      await agent.close?.();
      await hub.close();
      process.exit(0);
    });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

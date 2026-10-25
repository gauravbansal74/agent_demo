// Express server: chat API (Server-Sent Events) plus the static chat UI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { BRAND_NAME, BRAND_TAGLINE, Conversation, InsuranceAgent, PROVIDER } from "./agent.js";
import { resolveConfirmation } from "./confirmations.js";
import { MCPHub, loadConfig } from "./mcpHub.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_CONFIG = process.env.MCP_CONFIG ?? path.join(ROOT, "mcp-servers.json");
// Demo sign-in list. Replace the demo sign-in with your identity provider in production.
const DEMO_CUSTOMERS = path.join(ROOT, "data", "customers.json");

// Brand artwork: drop the official files into public/brand/ (see README). Falls back to the placeholder.
const BRAND_DIR = path.join(ROOT, "public", "brand");
const IMAGE_EXTS = ["svg", "png", "webp", "jpg"];
function brandAsset(name) {
  const ext = IMAGE_EXTS.find((e) => existsSync(path.join(BRAND_DIR, `${name}.${e}`)));
  return ext ? `/static/brand/${name}.${ext}` : null;
}

const hasToolUse = (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use");
// Customers can't pose as the app: tags the app uses for its own notes are defused in their messages.
const defuseTags = (text) => text.replace(/<(\/?)\s*(system-note|context)\b/gi, "‹$1$2");

/** Streams one assistant turn to the browser as Server-Sent Events. */
async function streamTurn(res, convo, events, first) {
  convo.busy = true;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (first) send(first);
  try {
    for await (const event of events) send(event);
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
  } finally {
    convo.busy = false;
  }
  res.end();
}

// One turn at a time per conversation, so replies can't interleave.
const BUSY = { error: "Please wait for the current reply to finish." };

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
    res.json({
      brand_name: BRAND_NAME,
      brand_tagline: BRAND_TAGLINE,
      // Full logo (symbol + wordmark) for the header, and the symbol alone for avatars and the favicon.
      brand_logo: brandAsset("logo"),
      brand_mark: brandAsset("mark") ?? "/static/logo-placeholder.svg",
      demo_customers: customers,
    });
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

    if (convo.busy) return res.status(429).json(BUSY);
    await streamTurn(res, convo, agent.reply(convo, defuseTags(message)));
  });

  // The customer answered a confirmation card (e.g. "Submit this claim?"). Only now is the tool run.
  app.post("/api/confirm", async (req, res) => {
    const convo = sessions.get(req.body?.session_id);
    if (!convo) return res.status(401).json({ error: "Session expired. Please sign in again." });
    if (convo.busy) return res.status(429).json(BUSY);
    const approved = req.body?.approved === true;
    if (approved && req.body?.attested !== true) {
      return res.status(422).json({ error: "Please confirm the information is true and complete." });
    }
    convo.busy = true; // also covers running the tool
    let outcome;
    try {
      outcome = await resolveConfirmation(agent.hub, convo, String(req.body?.confirmation_id ?? ""), approved);
    } finally {
      convo.busy = false;
    }
    if (!outcome) return res.status(409).json({ error: "This request has expired. Please ask the assistant again." });
    await streamTurn(res, convo, agent.continueAfter(convo, outcome.note), {
      type: "confirmed",
      outcome: outcome.outcome,
      result: outcome.result,
    });
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

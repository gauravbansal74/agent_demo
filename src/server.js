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
const defuseTags = (text) => text.replace(/<(\/?)\s*(system-note|context|attachments)\b/gi, "‹$1$2");

// Customer uploads (claim documents). The type is taken from the file's first bytes, not from
// what the browser claims, and files stay in the chat session until it ends.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_UPLOADS_PER_CHAT = 20;
const FILE_SIGNATURES = [
  { type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/webp", test: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  { type: "application/pdf", test: (b) => b.toString("latin1", 0, 5) === "%PDF-" },
];
const sniffType = (buf) => FILE_SIGNATURES.find((s) => s.test(buf))?.type ?? null;
const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
// Tells the assistant which files came with a message; the contents stay on the server.
const attachmentsNote = (files) =>
  `<attachments>\n${files.map((f) => `- upload_id: ${f.id} | ${f.name} | ${f.type} | ${kb(f.size)}`).join("\n")}\n</attachments>\n\n`;

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
    const ids = Array.isArray(req.body?.attachments) ? req.body.attachments.map(String) : [];
    const files = ids.map((id) => convo.uploads.get(id));
    if (files.some((f) => !f)) return res.status(422).json({ error: "One of the attached files was not found. Please upload it again." });
    if ((!message && !files.length) || message.length > 4000) {
      return res.status(422).json({ error: "message must be 1-4000 characters" });
    }

    if (convo.busy) return res.status(429).json(BUSY);
    const text = (files.length ? attachmentsNote(files) : "") + (defuseTags(message) || "(The customer sent the attached files without a message.)");
    await streamTurn(res, convo, agent.reply(convo, text));
  });

  // A file the customer attaches in the chat (e.g. a receipt photo). Raw body; name in X-File-Name.
  app.post("/api/upload", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const convo = sessions.get(req.get("X-Session-Id"));
    if (!convo) return res.status(401).json({ error: "Session expired. Please sign in again." });
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) return res.status(422).json({ error: "The file is empty." });
    const type = sniffType(data);
    if (!type) return res.status(415).json({ error: "Please upload a photo (JPG, PNG or WebP) or a PDF." });
    if (convo.uploads.size >= MAX_UPLOADS_PER_CHAT) {
      return res.status(429).json({ error: `You can upload up to ${MAX_UPLOADS_PER_CHAT} files in one chat.` });
    }
    let name = "document";
    try {
      name = decodeURIComponent(req.get("X-File-Name") ?? "document");
    } catch {}
    // Keep names short and free of path or control characters.
    name = name.replace(/[\\/\x00-\x1f<>]/g, "_").slice(-120) || "document";
    const upload = { id: `UPL-${randomBytes(4).toString("hex")}`, name, type, size: data.length, data };
    convo.uploads.set(upload.id, upload);
    res.json({ upload_id: upload.id, name, type, size: upload.size });
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
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "That file is too large. The limit is 8 MB." });
    next(err);
  });
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

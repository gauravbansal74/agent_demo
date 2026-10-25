// Alternative agent that runs on GitHub Copilot (via the Copilot SDK) instead of the Claude API.
// Intended for demos where a Copilot subscription is available but an LLM API is not.
//
// Copilot's agent is built for coding, so it ships with built-in tools that read and write
// files and run shell commands. Here every built-in tool is disabled: the session can only
// call the policy and claims tools, which go through the same MCPHub (and the same
// customer-id injection) as the Claude agent.
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CopilotClient, ToolSet, defineTool } from "@github/copilot-sdk";
import { SYSTEM_PROMPT, toolLabel } from "./agent.js";
import { holdForConfirmation } from "./confirmations.js";

export const COPILOT_MODEL = process.env.COPILOT_MODEL ?? "gpt-5";
const EFFORT = process.env.CLAUDE_EFFORT ?? "medium";

/** Turns session events into a pull-based async iterator. */
function eventQueue() {
  const items = [];
  let wake = null;
  return {
    push(item) {
      items.push(item);
      wake?.();
    },
    async *drain() {
      for (;;) {
        while (items.length) {
          const item = items.shift();
          yield item;
          if (item.type === "done") return;
        }
        await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

export class CopilotAgent {
  constructor(hub, client) {
    this.hub = hub;
    // "empty" mode is the SDK's multi-user server mode: no CLI defaults, no cross-session store.
    // Auth: COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, or the user signed in to Copilot CLI.
    // Sandbox working directory, so even a misconfigured tool filter has nothing of ours to touch.
    const sandbox = mkdtempSync(path.join(tmpdir(), "copilot-agent-"));
    const token = process.env.COPILOT_GITHUB_TOKEN;
    this.client =
      client ??
      new CopilotClient({
        mode: "empty",
        logLevel: "error",
        workingDirectory: sandbox,
        // With a token, keep all Copilot state in the sandbox. Without one, use the Copilot CLI's
        // home (~/.copilot) so the account from `copilot login` is picked up.
        baseDirectory: token ? sandbox : (process.env.COPILOT_HOME ?? path.join(homedir(), ".copilot")),
        ...(token ? { gitHubToken: token } : { useLoggedInUser: true }),
      });
    this.started = null;
  }

  /** For the "Behind the scenes" panel. */
  describe() {
    return { provider: "GitHub Copilot", model: COPILOT_MODEL };
  }

  async #session(convo) {
    if (convo.copilotSession) return convo.copilotSession;
    this.started ??= this.client.start();
    await this.started;
    const tools = this.hub.claudeTools().map((t) =>
      defineTool(t.name, {
        description: t.description,
        parameters: t.input_schema,
        skipPermission: true,
        defer: "never",
        handler: async (args) => {
          // Tools that change something wait for the customer's confirmation instead of running now.
          const held = await holdForConfirmation(this.hub, convo, t.name, args);
          if (held?.event) convo.emit?.(held.event);
          const { text, isError } = held?.result ?? (await this.hub.call(t.name, args, convo.customerId, convo.uploads, convo.trace));
          return { textResultForLlm: text, resultType: isError ? "failure" : "success" };
        },
      }),
    );
    convo.copilotSession = await this.client.createSession({
      model: COPILOT_MODEL,
      reasoningEffort: EFFORT,
      streaming: true,
      tools,
      // Only our custom tools: no file, shell, web or memory tools.
      availableTools: new ToolSet().addCustom("*"),
      systemMessage: { mode: "replace", content: SYSTEM_PROMPT },
      // Anything that still asks for permission is refused.
      onPermissionRequest: () => ({ kind: "reject", feedback: "Only the policy and claims tools are available." }),
    });
    return convo.copilotSession;
  }

  /** Runs one customer turn. Yields the same UI events as InsuranceAgent: text, tool, confirm, error, done. */
  async *reply(convo, userText) {
    const today = new Date().toISOString().slice(0, 10);
    yield* this.#run(convo, { prompt: `<context>Today is ${today}.</context>\n\n${userText}` });
  }

  /** Lets the assistant respond to something the app did, such as the customer confirming a claim. */
  async *continueAfter(convo, note) {
    yield* this.#run(convo, { prompt: `<system-note>${note}</system-note>`, source: "system" });
  }

  async *#run(convo, message) {
    const session = await this.#session(convo);
    const queue = eventQueue();
    const unsubscribe = [
      session.on("assistant.message_delta", (e) => queue.push({ type: "text", text: e.data.deltaContent })),
      session.on("tool.execution_start", (e) =>
        queue.push({ type: "tool", name: e.data.toolName, label: toolLabel(e.data.toolName) }),
      ),
      session.on("session.error", (e) => {
        console.error("Copilot session error", e.data);
        queue.push({ type: "error", text: "Something went wrong on our side. Please try again." });
        queue.push({ type: "done" });
      }),
      session.on("session.idle", () => queue.push({ type: "done" })),
    ];
    // Tool handlers run inside the session, so they hand UI events (confirmation cards) to this turn.
    convo.emit = (event) => queue.push(event);
    // Copilot runs its own tool loop, so the whole turn is one step; MCP calls show up inside it.
    const step = convo.trace.start("llm", "GitHub Copilot turn", { model: COPILOT_MODEL, effort: EFFORT });
    let chars = 0;
    try {
      await session.send(message);
      for await (const event of queue.drain()) {
        if (event.type === "text") chars += event.text.length;
        yield event;
      }
      step.end({ reply_characters: chars });
    } finally {
      convo.emit = null;
      for (const off of unsubscribe) off();
    }
  }

  async endConversation(convo) {
    await convo.copilotSession?.disconnect().catch(() => {});
    convo.copilotSession = null;
  }

  async close() {
    if (this.started) await this.client.stop();
  }
}

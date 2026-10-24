// Alternative agent that runs on GitHub Copilot (via the Copilot SDK) instead of the Claude API.
// Intended for demos where a Copilot subscription is available but an LLM API is not.
//
// Copilot's agent is built for coding, so it ships with built-in tools that read and write
// files and run shell commands. Here every built-in tool is disabled: the session can only
// call the policy and claims tools, which go through the same MCPHub (and the same
// customer-id injection) as the Claude agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopilotClient, ToolSet, defineTool } from "@github/copilot-sdk";
import { SYSTEM_PROMPT, toolLabel } from "./agent.js";

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
    // Sandbox directory for the runtime's working files and session state, so even a
    // misconfigured tool filter has nothing of ours to touch.
    const sandbox = mkdtempSync(path.join(tmpdir(), "copilot-agent-"));
    this.client =
      client ??
      new CopilotClient({
        mode: "empty",
        logLevel: "error",
        workingDirectory: sandbox,
        baseDirectory: sandbox,
        ...(process.env.COPILOT_GITHUB_TOKEN ? { gitHubToken: process.env.COPILOT_GITHUB_TOKEN } : {}),
      });
    this.started = null;
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
          const { text, isError } = await this.hub.call(t.name, args, convo.customerId);
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

  /** Runs one customer turn. Yields the same UI events as InsuranceAgent: text, tool, error, done. */
  async *reply(convo, userText) {
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
    try {
      const today = new Date().toISOString().slice(0, 10);
      await session.send({ prompt: `<context>Today is ${today}.</context>\n\n${userText}` });
      yield* queue.drain();
    } finally {
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

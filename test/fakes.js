// A scripted stand-in for the Anthropic client so the agent loop can be tested offline.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/mcpHub.js";

// Tests run the mock MCP servers on their own copy of the sample data (test/fixtures), so editing
// data/ or mcp-servers.json for a demo doesn't break them.
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
process.env.DEMO_CUSTOMERS = path.join(FIXTURES, "customers.json");

/** Mock-server MCP config pointed at the fixtures, with "today" pinned for the claim window checks. */
export function mockConfig() {
  const config = loadConfig(path.join(FIXTURES, "..", "..", "mcp-servers.mock.json"));
  for (const server of Object.values(config.servers)) {
    server.env = { ...server.env, INSURANCE_DATA_DIR: FIXTURES, MOCK_TODAY: "2026-10-24" };
  }
  return config;
}
export const message = (content, stop_reason) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test-model",
  content,
  stop_reason,
  usage: { input_tokens: 1, output_tokens: 1 },
});

export class FakeClient {
  /** Returns the scripted messages in order and records every request. */
  constructor(script) {
    this.script = [...script];
    this.requests = [];
    this.beta = { messages: { stream: (params) => this.#stream(params) } };
  }

  #stream(params) {
    // Snapshot the messages: the agent keeps appending to the same array.
    this.requests.push({ ...params, messages: structuredClone(params.messages) });
    const msg = this.script.shift();
    return {
      async *[Symbol.asyncIterator]() {
        for (const block of msg.content) {
          if (block.type === "text") yield { type: "content_block_delta", delta: { type: "text_delta", text: block.text } };
        }
      },
      finalMessage: async () => msg,
    };
  }
}

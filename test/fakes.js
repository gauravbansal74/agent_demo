// A scripted stand-in for the Anthropic client so the agent loop can be tested offline.
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

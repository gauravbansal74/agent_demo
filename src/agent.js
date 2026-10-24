// The customer chat agent: Claude plus the tools from the connected MCP servers.
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

// "anthropic" calls the Claude API directly; "bedrock" calls Claude on Amazon Bedrock
// using the standard AWS credential chain (env vars, ~/.aws profile, or an IAM role).
// "copilot" uses the GitHub Copilot SDK instead (see copilotAgent.js).
export const PROVIDER = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
const ON_BEDROCK = PROVIDER === "bedrock";
// Bedrock model IDs carry an "anthropic." prefix.
export const MODEL = process.env.CLAUDE_MODEL ?? (ON_BEDROCK ? "anthropic.claude-opus-5-5" : "claude-opus-5-5");
const EFFORT = process.env.CLAUDE_EFFORT ?? "medium";
// Server-side refusal fallback is a Claude API feature; it is not available on Bedrock.
const USE_FALLBACKS = !ON_BEDROCK && (process.env.CLAUDE_FALLBACKS ?? "true").toLowerCase() === "true";

export function createClaudeClient() {
  if (ON_BEDROCK) return new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION });
  if (PROVIDER !== "anthropic" && PROVIDER !== "copilot") throw new Error(`Unknown LLM_PROVIDER ${JSON.stringify(PROVIDER)}`);
  return new Anthropic();
}
export const BRAND_NAME = process.env.BRAND_NAME ?? "Sun Life";
const MAX_TOOL_ROUNDS = 8;

export const SYSTEM_PROMPT = `You are the ${BRAND_NAME} virtual assistant, chatting with a signed-in customer about their own insurance policies and claims.

Use the tools to look up the customer's real records before answering anything about their policies, coverage, premiums, beneficiaries or claims. Never guess or invent policy numbers, amounts, dates or statuses. If the tools don't have the answer, say so and suggest contacting their advisor or customer service.

The tools only ever return this customer's own records, so you never need to ask for their customer ID. If they ask about someone else's policy, explain that you can only discuss policies on their own account.

Style: warm, clear and concise, in plain language a non-expert understands. Lead with the direct answer, then the key details. Format money as Canadian dollars (e.g. $1,500.00). Use short bullet lists or a small table when comparing several items. When a claim needs something from the customer (missing documents, an appeal deadline), call that out clearly with the date.

You can explain information but cannot change anything: you can't submit or edit claims, change beneficiaries, or process payments. For those, point the customer to the online portal, the mobile app or their advisor. Don't give medical, legal or tax advice, and don't promise a claim outcome.`;

/** 'claims__get_claim_status' -> 'Get claim status' for the UI activity line. */
export const toolLabel = (name) => {
  const s = name.split("__").pop().replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export class Conversation {
  constructor(customerId) {
    this.customerId = customerId;
    /** @type {Anthropic.Beta.BetaMessageParam[]} */
    this.messages = [];
  }
}

export class InsuranceAgent {
  constructor(hub, client = createClaudeClient()) {
    this.hub = hub;
    this.client = client;
  }

  #params(convo) {
    const params = {
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: this.hub.claudeTools(),
      messages: convo.messages,
      output_config: { effort: EFFORT },
    };
    if (USE_FALLBACKS) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    return params;
  }

  /** Runs one customer turn. Yields UI events: text, tool, error, done. */
  async *reply(convo, userText) {
    // Today's date goes in the user turn, not the system prompt, so the cached prefix stays stable.
    const today = new Date().toISOString().slice(0, 10);
    convo.messages.push({ role: "user", content: `<context>Today is ${today}.</context>\n\n${userText}` });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = this.client.beta.messages.stream(this.#params(convo));
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      const message = await stream.finalMessage();

      // Keep the full content (thinking, fallback and tool_use blocks) so the next request replays it unchanged.
      convo.messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        yield { type: "error", text: "Sorry, I can't help with that request. Please contact customer service." };
        break;
      }
      if (message.stop_reason === "pause_turn") continue;
      const toolUses = message.content.filter((b) => b.type === "tool_use");
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results = [];
      for (const block of toolUses) {
        yield { type: "tool", name: block.name, label: toolLabel(block.name) };
        const { text, isError } = await this.hub.call(block.name, block.input, convo.customerId);
        console.log(`tool ${block.name}(${JSON.stringify(block.input)}) error=${isError}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: isError });
      }
      // All results for one assistant turn go back in a single user message.
      convo.messages.push({ role: "user", content: results });

      if (round === MAX_TOOL_ROUNDS - 1) {
        yield { type: "error", text: "That took more steps than expected. Please try rephrasing your question." };
      }
    }
    yield { type: "done" };
  }
}

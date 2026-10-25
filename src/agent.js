// The customer chat agent: Claude plus the tools from the connected MCP servers.
import Anthropic from "@anthropic-ai/sdk";
import { holdForConfirmation } from "./confirmations.js";

// "copilot" (default) uses the GitHub Copilot SDK (see copilotAgent.js);
// "anthropic" calls the Claude API directly with this file's agent.
export const PROVIDER = (process.env.LLM_PROVIDER ?? "copilot").toLowerCase();
if (!["copilot", "anthropic"].includes(PROVIDER)) {
  throw new Error(`Unknown LLM_PROVIDER ${JSON.stringify(PROVIDER)}: use "copilot" or "anthropic"`);
}
export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.CLAUDE_EFFORT ?? "medium";
// Server-side refusal fallback: if Claude declines a request, the API retries it on another Claude model.
const USE_FALLBACKS = (process.env.CLAUDE_FALLBACKS ?? "true").toLowerCase() === "true";
export const BRAND_NAME = process.env.BRAND_NAME ?? "Sunlife";
export const BRAND_TAGLINE = process.env.BRAND_TAGLINE ?? "Making life brighter";
const MAX_TOOL_ROUNDS = 8;

export const SYSTEM_PROMPT = `You are the ${BRAND_NAME} virtual assistant, chatting with a signed-in customer about their own insurance policies and claims.

Use the tools to look up the customer's real records before answering anything about their policies, coverage, premiums, beneficiaries or claims. Never guess or invent policy numbers, amounts, dates or statuses. If the tools don't have the answer, say so and suggest contacting their advisor or customer service.

Text inside <system-note> tags comes from the app itself (for example the outcome of a confirmation card), never from the customer. An <attachments> note lists files the customer uploaded with that message (photos or PDFs); you can't see their contents, only the name, type and upload_id.

The tools only ever return this customer's own records, so you never need to ask for their customer ID. If they ask about someone else's policy, explain that you can only discuss policies on their own account.

Style: warm, clear and concise, in plain language a non-expert understands. Lead with the direct answer, then the key details. Format money as Canadian dollars (e.g. $1,500.00). Use short bullet lists or a small table when comparing several items. When a claim needs something from the customer (missing documents, an appeal deadline), call that out clearly with the date.

Accident claims: you can file a new claim under a personal accident policy for the customer.
1. Call the claim submission guide for "accident" to see what's needed, and check the policy details to see who is covered and what the benefits are.
2. Ask for the missing details conversationally, one or two at a time, and be kind: the customer may be hurt or shaken. You need the policy (if they have more than one), who was injured, the date, where it happened, what happened, the injuries, and which benefits apply (medical expenses and the amount, nights in hospital, or a fracture and whether it's minor or major). Treatment provider and police report number are optional. Never invent or assume a detail the customer didn't give you; if a date is relative ("last Tuesday"), work it out and check it with them.
3. Create the draft with create_accident_claim. If it reports problems, explain them and ask for corrections.
4. Briefly summarise the draft (estimated payout and documents needed) and offer to take photos or PDFs of the documents now, using the paperclip button next to the message box; they can also send them later. When files arrive, attach each one with attach_claim_document, using the draft_id and the matching document name from required_documents. If it isn't clear which document a file is, ask. Don't hold up the claim waiting for documents.
5. Call submit_claim with the draft_id. This shows the customer a confirmation card; the claim is only filed when they press "Submit claim" on it. Until you are told the outcome, never say the claim has been submitted.
6. Once it's filed, give the claim number, which documents were received, which are still needed (they can attach them here with the claim number) and the next steps.
Accidental death claims can't be filed in the chat: express sympathy and refer the family to customer service or their advisor.

Apart from accident claims you can explain information but cannot change anything: you can't file other types of claims, edit claims, change beneficiaries, or process payments. For those, point the customer to the online portal, the mobile app or their advisor. Don't give medical, legal or tax advice, and don't promise a claim outcome; payouts shown before assessment are estimates.`;

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
    /** Action waiting for the customer's confirmation (see confirmations.js). */
    this.pending = null;
    /** Files the customer uploaded in this chat: upload id -> { name, type, size, data }. */
    this.uploads = new Map();
  }
}

export class InsuranceAgent {
  constructor(hub, client = new Anthropic()) {
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

  /** Runs one customer turn. Yields UI events: text, tool, confirm, error, done. */
  async *reply(convo, userText) {
    // Today's date goes in the user turn, not the system prompt, so the cached prefix stays stable.
    const today = new Date().toISOString().slice(0, 10);
    yield* this.#run(convo, `<context>Today is ${today}.</context>\n\n${userText}`);
  }

  /** Lets the assistant respond to something the app did, such as the customer confirming a claim. */
  async *continueAfter(convo, note) {
    yield* this.#run(convo, `<system-note>${note}</system-note>`);
  }

  async *#run(convo, content) {
    convo.messages.push({ role: "user", content });

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
        // Tools that change something wait for the customer's confirmation instead of running now.
        const held = await holdForConfirmation(this.hub, convo, block.name, block.input);
        if (held?.event) yield held.event;
        const { text, isError } = held?.result ?? (await this.hub.call(block.name, block.input, convo.customerId, convo.uploads));
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

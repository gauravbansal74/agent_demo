// Customer confirmation for tools that change something, such as filing a claim.
//
// The MCP config lists these tools under "confirm":
//   "confirm": { "claims__submit_claim": { "title": "Submit this claim?", "confirmLabel": "Submit claim", "preview": "claims__get_claim_draft" } }
// When the LLM calls one, the tool is NOT run. The customer is shown a confirmation card (filled
// from the optional preview tool, called with the same arguments) and the backend runs the tool
// only when the customer presses the button (POST /api/confirm). The LLM can't skip this step.
import { randomUUID } from "node:crypto";

const AWAITING =
  "Not submitted yet. The customer is now looking at a confirmation card with the details and must press the button to confirm. " +
  "Briefly ask them to review the card and confirm or cancel, then stop. Do not say it has been submitted; you will be told the outcome.";

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

/**
 * Called before running a tool. Returns null if the tool needs no confirmation. Otherwise records
 * the pending action on the conversation and returns { event, result }: the UI event for the card
 * and the tool result to give the LLM instead of running the tool.
 */
export async function holdForConfirmation(hub, convo, name, args) {
  const rule = hub.confirmations[name];
  if (!rule) return null;
  let preview = null;
  if (rule.preview) {
    const { text, isError } = await hub.call(rule.preview, args, convo.customerId, convo.uploads);
    preview = parse(text);
    // Nothing to confirm (e.g. unknown draft): let the LLM see the problem and fix it.
    if (isError || preview?.error) return { event: null, result: { text, isError: true } };
  }
  // Only the latest request can be confirmed; an older card stops working.
  convo.pending = { id: randomUUID(), name, args };
  return {
    event: {
      type: "confirm",
      id: convo.pending.id,
      title: rule.title ?? "Please confirm",
      confirm_label: rule.confirmLabel ?? "Confirm",
      preview,
    },
    result: { text: AWAITING, isError: false },
  };
}

/**
 * Runs (or cancels) the pending action after the customer answers the card.
 * Returns null if `id` isn't the pending action, otherwise { outcome, result, note } where `note`
 * tells the LLM what happened so it can explain the outcome to the customer.
 */
export async function resolveConfirmation(hub, convo, id, approved) {
  const pending = convo.pending;
  if (!pending || pending.id !== id) return null;
  convo.pending = null; // cleared before any await, so a double click can't run the tool twice
  if (!approved) {
    return {
      outcome: "cancelled",
      result: null,
      note: "The customer pressed Cancel on the confirmation card, so nothing was submitted. Acknowledge this briefly and ask whether they'd like to change any details or leave it for now.",
    };
  }
  const { text, isError } = await hub.call(pending.name, pending.args, convo.customerId, convo.uploads);
  console.log(`confirmed tool ${pending.name}(${JSON.stringify(pending.args)}) error=${isError}`);
  const result = parse(text);
  const failed = isError || Boolean(result?.error);
  return {
    outcome: failed ? "failed" : "done",
    result,
    note: failed
      ? `The customer confirmed, but the action failed with this result: ${text}\nExplain the problem in plain language and what they can do next.`
      : `The customer reviewed the details, confirmed they are true and complete, and pressed the confirm button. It has now been carried out. Result: ${text}\nTell the customer it's done, give the reference number, and list the next steps and documents they need to provide.`,
  };
}

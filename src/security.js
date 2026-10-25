// Execution controller: the security checks shown in the "Behind the scenes" panel.
//
// DEMO MODE: the controller runs in bypass. It reports what a production deployment would
// verify between each part (browser, backend, AI model, MCP servers), but it never blocks
// anything and the MCP servers aren't sent real tokens. Checks marked `enforced: true` are ones
// the app really does elsewhere (customer id injection, upload ownership, confirmation gate,
// tag defusing); the rest are illustrations. Set SHOW_SECURITY=false to leave them out of the panel.
import { randomBytes } from "node:crypto";

export const SHOW_SECURITY = (process.env.SHOW_SECURITY ?? "true").toLowerCase() !== "false";
const MODE = "bypass (demo): checks are shown, not enforced";
const TOKEN_TTL_S = 300;

const check = (name, result, enforced = false) => ({ name, result, passed: true, enforced });
const jti = () => randomBytes(6).toString("hex");
const isWrite = (tool) => !/^(get|list|search|read|describe)_/.test(tool);

function report(trace, title, checks, extra = {}) {
  if (!SHOW_SECURITY) return;
  trace.point("security", title, { controller: MODE, passed: `${checks.length}/${checks.length}`, checks, ...extra });
}

/** Browser -> backend: a customer message (or a confirmation) arrives. */
export function requestChecks(trace, { customerId, message = "", files = [], defused = 0, confirmation = false }) {
  const checks = [
    check("Session token", `valid, bound to customer ${customerId}`, true),
    check("Origin and CSRF", "same-origin request, anti-CSRF header present"),
    check("Rate limit", "within 30 requests per minute for this session"),
  ];
  if (confirmation) {
    checks.push(
      check("Confirmation id", "matches the pending action and can be used once", true),
      check("Customer attestation", "\"true and complete\" box ticked before submit", true),
    );
  } else {
    checks.push(
      check("Input validation", `${message.length} of 4,000 characters allowed`, true),
      check("Prompt-injection guard", defused ? `${defused} app tag(s) removed from the message` : "no app tags in the message", true),
      check("Sensitive data scan", "no card or bank numbers found in the message"),
    );
    if (files.length) checks.push(check("Uploads", `${files.length} file(s) belong to this chat and were type-checked by content`, true));
  }
  report(trace, "Execution controller: request verified", checks);
}

/** Backend -> AI model: before each request to the LLM. */
export function llmChecks(trace, { provider, toolsOffered = [] }) {
  report(trace, "Execution controller: AI request policy", [
    check("Tool allowlist", `${toolsOffered.length || "all"} approved tool(s) offered to the model`),
    check("Customer identity", "customer id hidden from the model; the backend supplies it", true),
    check("System prompt", "pinned by the backend, customer text can't replace it"),
    check("Provider connection", `${provider ?? "AI provider"} over TLS 1.3, API key from the secret store`),
  ]);
}

/** Backend -> MCP server: before each tool call. */
export function toolChecks(trace, { server, transport, tool, scoped, customerArg, customerId, takesUpload, gated }) {
  const scope = `${server}:${isWrite(tool) ? "write" : "read"}`;
  const checks = [
    check("Tool allowlist", `${server} › ${tool} is approved for the assistant`, true),
    check("Action policy", isWrite(tool) ? (gated ? "write action, customer confirmation required" : "write action allowed") : "read-only action", gated),
  ];
  if (scoped) checks.push(check("Customer binding", `${customerArg} set to ${customerId} from the session; any value from the model is ignored`, true));
  checks.push(check("Argument validation", "arguments match the tool's input schema"));
  if (takesUpload) checks.push(check("File ownership", "file comes from this chat's uploads; contents never sent to the model", true));
  checks.push(
    check("MCP auth token", `OAuth 2.1 client credentials, audience mcp-${server}, scope ${scope}, expires in ${TOKEN_TTL_S} s`),
    check("Channel", transport === "stdio" ? "local process (stdio), no network hop" : `${transport.replace("_", " ")} over mutual TLS`),
    check("Server-side verification", `MCP server ${server} verified signature, audience, scope and expiry`),
  );
  report(trace, `Execution controller: ${server} › ${tool} allowed`, checks, {
    auth: { scheme: "Bearer", token_id: jti(), audience: `mcp-${server}`, scope, expires_in: TOKEN_TTL_S, subject: customerId },
  });
}

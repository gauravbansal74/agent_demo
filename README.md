# Insurance Customer Chat Agent (Node.js)

A customer-facing chat assistant for an insurance company, built as a demo. A signed-in customer asks about their own policies and claims in plain language, and can file an accident claim right in the chat; an LLM answers by calling tools on your **policy and claims MCP servers**. The chat UI follows the Sunlife brand ("Making life brighter": sunshine yellow, deep navy, clean type, rounded cards) and shows the official logo once you add it to `public/brand/`.

```
Browser (chat UI)  ──SSE──►  Express backend  ──►  LLM: GitHub Copilot or Claude API
                                   │
                                   └──►  MCP hub ──►  your Policy MCP server
                                                 └──►  your Claims MCP server
```

Built with Node.js (20.19+ or 22.12+), Express, the official [MCP SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk), and one of two LLM back ends: the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) or the [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk).

See [CHANGELOG.md](CHANGELOG.md) for what changed and when.

## Quick start

```bash
npm install
cp .env.example .env            # then pick an LLM below and fill in its settings
npm start                       # same as: node --env-file=.env src/server.js
```

Open http://localhost:3000, pick a demo customer and start chatting.

Out of the box `mcp-servers.json` points at two small **mock** MCP servers in `mock-mcp-servers/` (sample data in `data/`), so you can try the app before wiring in your real servers.

## Choose an LLM

Set `LLM_PROVIDER` in `.env`. Everything else (MCP servers, customer scoping, UI) works the same with both.

### GitHub Copilot (`LLM_PROVIDER=copilot`, default)

```bash
LLM_PROVIDER=copilot
# COPILOT_GITHUB_TOKEN=...      # optional, see below
# COPILOT_MODEL=gpt-5
```

- Auth: by default the app reuses your Copilot CLI sign-in (run `copilot login` once). Alternatively set `COPILOT_GITHUB_TOKEN` to the output of `gh auth token`, or to a fine-grained personal access token with the "Copilot Requests" permission.
- Model: `COPILOT_MODEL` (default `gpt-5`). Any model your Copilot plan offers works, for example `claude-sonnet-4.5`.
- Safety: Copilot's agent is built for coding and normally has file, shell and web tools. This app disables all of them; the session can only call the policy and claims tools, which still go through the same customer-id injection.
- Every customer message counts against that Copilot account's usage. Use this for demos; check GitHub's terms before serving real customers.

### Claude API (`LLM_PROVIDER=anthropic`)

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Uses Claude Opus 5.5 by default (`CLAUDE_MODEL`), with the server-side refusal fallback turned on (`CLAUDE_FALLBACKS`).

## Connect your own MCP servers

Edit `mcp-servers.json` (or point `MCP_CONFIG` at another file). See `mcp-servers.example.json`. Each server can use any of the three MCP transports:

```json
{
  "customerIdArgument": "customer_id",
  "servers": {
    "policies": { "transport": "streamable_http", "url": "${POLICY_MCP_URL}", "headers": { "Authorization": "Bearer ${POLICY_MCP_TOKEN}" } },
    "claims":   { "transport": "sse",             "url": "${CLAIMS_MCP_URL}", "headers": { "x-api-key": "${CLAIMS_MCP_API_KEY}" } },
    "local":    { "transport": "stdio",           "command": "node", "args": ["path/to/server.js"] }
  }
}
```

`${VAR}` values are read from the environment, so URLs and secrets stay out of the file. Tools are discovered automatically at startup and exposed to the LLM as `<server>__<tool>`. `GET /api/tools` lists what was found.

### Customer scoping (important)

If a tool has an argument named `customer_id` (configurable via `customerIdArgument`), the backend **removes it from what the LLM sees and fills it in from the signed-in session** on every call. The LLM can never request another customer's records, even if a user tries to trick it. If your servers identify the customer differently (for example a per-user token), adapt `MCPHub.call` in `src/mcpHub.js`.

## Accident claims in the chat

Customers with a personal accident policy can file a claim by chatting, for example "I had an accident and want to make a claim". The demo customers Priya Sharma (C1001) and Aisha Bello (C1003) each have one.

1. The assistant asks for the details a step at a time: who was hurt, when and where, what happened, the injuries, and which benefits apply (medical expenses, nights in hospital, fracture).
2. It creates a **draft** (`create_accident_claim`). The claims server checks it against the policy: the policy must be an active accident policy on this customer's account, the injured person must be covered, and the accident must be within the 90-day claim window and not in the future. It returns the estimated payout (with policy limits applied) and the documents needed.
3. When the assistant calls `submit_claim`, the claim is **not** filed. The customer sees a confirmation card with the details, estimated payout and required documents. They tick "I confirm this information is true and complete" and press **Submit claim** (or Cancel).
4. Only then does the backend run `submit_claim` (`POST /api/confirm`). The new claim number appears in the chat, and the claim shows up in "list claims" and "claim status" with its outstanding documents.

The confirmation step is enforced by the backend, not by the LLM's good behaviour: tools listed under `confirm` in `mcp-servers.json` never run from a model call. The same works for any of your own tools that change something:

```json
"confirm": {
  "claims__submit_claim": { "title": "Submit this claim?", "confirmLabel": "Submit claim", "preview": "claims__get_claim_draft" }
}
```

`preview` is an optional tool called with the same arguments to fill the card. It works best when it returns `title`, `summary` (a list of `{label, value}`), `benefits`, `estimated_total_payout`, `required_documents` and `disclaimer`, like the mock's `get_claim_draft`.

In the mock server, filed claims and drafts live in memory and disappear when the app restarts. Other claim types (health, dental, life and so on) are still pointed to the portal or app; accidental death claims are referred to customer service.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `copilot` | `copilot` (GitHub Copilot SDK) or `anthropic` (Claude API) |
| `COPILOT_GITHUB_TOKEN` | | Optional GitHub token with Copilot access; without it the `copilot login` account is used |
| `COPILOT_MODEL` | `gpt-5` | Copilot model (only for `copilot`) |
| `ANTHROPIC_API_KEY` | | Claude API key (only for `anthropic`) |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model (only for `anthropic`) |
| `CLAUDE_FALLBACKS` | `true` | Server-side refusal fallback (only for `anthropic`) |
| `CLAUDE_EFFORT` | `medium` | Reasoning effort for both providers; `low` is faster and cheaper for simple Q&A |
| `BRAND_NAME` | `Sunlife` | Name shown in the UI and used by the assistant |
| `BRAND_TAGLINE` | `Making life brighter` | Tagline shown on the sign-in page |
| `MCP_CONFIG` | `mcp-servers.json` | MCP server config file |
| `PORT` | `3000` | HTTP port |

## Branding

- **Logo:** save the official artwork into `public/brand/` as `logo.svg` (full logo for the header) and `mark.svg` (the symbol alone, for the chat avatar and browser tab). PNG, WebP or JPG also work. Restart the server and it's picked up automatically; see `public/brand/README.md`. Until then a placeholder sun icon and the brand name in text are shown.
- **Name and tagline:** `BRAND_NAME` (default `Sunlife`) and `BRAND_TAGLINE` (default `Making life brighter`). The name is also used by the assistant when it introduces itself.
- **Colours and font:** CSS variables at the top of `public/styles.css`. Swap in the exact values from your brand guidelines, and the licensed brand typeface if you have one.

## Project layout

```
src/
  server.js         Express app: sign-in, chat (Server-Sent Events), static UI; picks the LLM
  agent.js          Claude agent: tool-use loop, shared system prompt, provider setting
  copilotAgent.js   Same agent on the GitHub Copilot SDK (default)
  mcpHub.js         Connects to MCP servers, maps tools, injects customer id
  confirmations.js  Holds tools such as submit_claim until the customer confirms
public/             Chat UI (HTML/CSS/JS, vendored marked + DOMPurify)
  brand/            Drop the official logo files here
mock-mcp-servers/   Stand-in policy and claims MCP servers for local testing
data/               Sample customers, policies (incl. personal accident) and claims for the mocks
test/               Offline tests (the LLM is faked; mock MCP servers run for real)
CHANGELOG.md        Record of changes
```

## Tests

```bash
npm test
```

The tests need no API keys: Claude and Copilot are replaced by scripted fakes, while the mock MCP servers run for real.

## Before production

- Replace the demo sign-in (`POST /api/session`) with your real customer authentication and derive `customer_id` from the verified identity.
- Move chat sessions from memory to Redis or a database if you run more than one instance.
- Add rate limiting and audit logging of tool calls to suit your compliance requirements. Log each confirmation (who, when, what was attested) as part of the claim record.
- Have your claims server enforce its own rules (ownership, claim window, limits, duplicates) as the mock does; don't rely on the LLM or the UI for them.

## Contributing

Record every change in [CHANGELOG.md](CHANGELOG.md) under `Unreleased` (or a new version), and keep this README in step with the code.

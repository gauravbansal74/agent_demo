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

Out of the box `mcp-servers.json` points at two small **mock** MCP servers in `mock-mcp-servers/` (sample data in `data/`), so you can try the app before wiring in your real servers. `mcp-servers.mock.json` is the same mock setup kept separately: the tests use it, and you can switch back to the mocks any time with `MCP_CONFIG=mcp-servers.mock.json npm start`.

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

`${VAR}` values are read from the environment, so URLs and secrets stay out of the file. Tools are discovered automatically at startup and exposed to the LLM as `<server>__<tool>`. `GET /api/tools` lists what was found, and the startup log names each server's tools.

To see every tool with its arguments and how the app will use it, run:

```bash
npm run tools
```

It marks the customer id argument, file tools and tools that need the customer's confirmation, and if no tool takes files it suggests an `uploadArguments` line for a tool that looks like it does. Use it to fill in `confirm` and `uploadArguments` for your own servers: the names there must match yours exactly, as `<server>__<tool>`. A startup warning such as `"confirm" in the MCP config names unknown tool claims__submit_claim` means your claims server has no tool called `submit_claim`.

### Customer scoping (important)

If a tool has an argument named `customer_id` (configurable via `customerIdArgument`), the backend **removes it from what the LLM sees and fills it in from the signed-in session** on every call. The LLM can never request another customer's records, even if a user tries to trick it. If your servers identify the customer differently (for example a per-user token), adapt `MCPHub.call` in `src/mcpHub.js`.

## Accident claims in the chat

Customers with a personal accident policy can file a claim by chatting, for example "I had an accident and want to make a claim". The demo customers Emily Carter (C1001) and Sarah Mitchell (C1003) each have one.

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

## Photos and documents

Customers can attach photos (JPG, PNG, WebP) or PDFs with the paperclip button next to the message box, for example an X-ray report or hospital receipts. Files upload as soon as they're picked, show as thumbnails above the message box, and go with the next message.

- The assistant is told which files came with the message (name, type, size and an `upload_id`), never their contents. It attaches each one with `attach_claim_document`, to a draft before submission or to a filed claim afterwards, saying which required document it is.
- The confirmation card lists which documents are attached and which are still needed. After filing, the claim's outstanding documents shrink as files arrive.
- The backend checks each file by its contents (not its name), up to 8 MB and 20 files per chat, and keeps it in the chat session only.

**How the file reaches your MCP server.** Any tool whose input schema has a `content_base64` argument is treated as a file tool. The backend hides `content_base64`, `file_name` and `mime_type` from the LLM, shows an `upload_id` argument instead, and fills the three in from the customer's upload when the tool runs. The LLM can only send files uploaded in the same chat. If your server uses other argument names, map them in the MCP config:

```json
"uploadArguments": { "content": "fileData", "fileName": "fileName", "mimeType": "contentType" }
```

Only `content` is needed: the file name and type are sent only if the tool has those arguments. At startup the log says which tools take files, or warns that none does. In that case uploads still work in the chat, but the assistant can't add them to a claim; run `npm run tools` to find the right argument names.

The mock server checks the file type again, records a SHA-256 hash, and keeps only the file details in memory, not the file itself. A real server should store the file, virus-scan it, and enforce its own size and type limits.

In the mock server, filed claims and drafts live in memory and disappear when the app restarts. Other claim types (health, dental, life and so on) are still pointed to the portal or app; accidental death claims are referred to customer service.

## Behind the scenes (live technical flow)

For demos, the **Behind the scenes** button in the header opens a panel that shows, live, what happens for every message:

- a map of the parts involved (browser, backend, the AI model, each MCP server) that light up as each one works
- a timeline per message: the message reaching the backend, each request to the AI model (with the tools it asked for and token counts), every MCP tool call with its arguments and result, confirmation steps, and how long each took
- expandable details with the exact data sent and received. It shows which arguments the backend added itself (the customer id, file contents), and file contents are shown only as their size

With GitHub Copilot, Copilot runs its own tool loop, so its whole turn shows as one AI step with the MCP calls inside it. With the Claude API, each request to Claude shows separately.

### Security and the execution controller (demo)

The panel also shows an **Execution controller** between the backend and the AI model and MCP servers, and **Security** steps in the timeline:

- when a message or confirmation arrives: session token, origin and CSRF, rate limit, input validation, prompt-injection guard, sensitive data scan, upload ownership, and for confirmations the confirmation id and the customer's attestation
- before each AI request: tool allowlist, customer id hidden from the model, pinned system prompt, provider connection
- before each MCP call: tool allowlist, read or write policy, customer binding, argument validation, file ownership, the OAuth 2.1 token for that MCP server (audience, scope, expiry) and the server's verification of it

**This is a demo.** The controller runs in bypass mode (`src/security.js`): every check is shown as passed and nothing is blocked, and the MCP servers aren't sent real tokens. The panel lists the checks without raw JSON; in `src/security.js` each one records whether the app really enforces it (`enforced: true`: customer id injection, upload ownership, the confirmation step, tag defusing, input length) or whether it's an illustration of what production would add. Hide these steps with `SHOW_SECURITY=false`.

The panel shows customer data and tool results, so turn it off for real customers with `SHOW_FLOW=false`; the server then sends no trace at all.

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
| `DEMO_CUSTOMERS` | `data/customers.json` | Customers offered on the demo sign-in page. The id is read from the field named by `customerIdArgument` (e.g. `clientId`), or `customer_id` |
| `SHOW_FLOW` | `true` | Show the "Behind the scenes" panel; set `false` for real customers |
| `SHOW_SECURITY` | `true` | Show the execution controller and security checks in the panel (demo, not enforced) |
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
  trace.js          Live step-by-step trace for the "Behind the scenes" panel
  security.js       Execution controller checks shown in the panel (demo bypass mode)
public/             Chat UI (HTML/CSS/JS, vendored marked + DOMPurify)
  brand/            Drop the official logo files here
mock-mcp-servers/   Stand-in policy and claims MCP servers for local testing
scripts/list-tools.mjs  `npm run tools`: lists your MCP tools and suggests config
mcp-servers.mock.json  Config for the mock servers (used by the tests)
data/               Sample customers, policies (incl. personal accident) and claims for the mocks
test/               Offline tests (the LLM is faked; mock MCP servers run for real)
CHANGELOG.md        Record of changes
```

## Tests

```bash
npm test
```

The tests need no API keys: Claude and Copilot are replaced by scripted fakes, while the mock MCP servers run for real on their own copy of the sample data in `test/fixtures/`. You can edit `data/` and `mcp-servers.json` for your demo without breaking them.

## Before production

- Replace the demo sign-in (`POST /api/session`) with your real customer authentication and derive `customer_id` from the verified identity.
- Move chat sessions from memory to Redis or a database if you run more than one instance.
- Add rate limiting and audit logging of tool calls to suit your compliance requirements. Log each confirmation (who, when, what was attested) as part of the claim record.
- Set `SHOW_FLOW=false` so the technical panel and its data are not sent to customers.
- Scan uploaded files for malware and store them in your document system; the demo keeps them in memory for the chat only.
- Have your claims server enforce its own rules (ownership, claim window, limits, duplicates) as the mock does; don't rely on the LLM or the UI for them.

## Contributing

Record every change in [CHANGELOG.md](CHANGELOG.md) under `Unreleased` (or a new version), and keep this README in step with the code.

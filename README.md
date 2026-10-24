# Insurance Customer Chat Agent (Node.js)

A customer-facing chat assistant for an insurance company, built as a demo. A signed-in customer asks about their own policies and claims in plain language; an LLM answers by calling tools on your **policy and claims MCP servers**. The chat UI uses a Sun Life-inspired look (yellow on navy, clean type, rounded cards).

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
| `BRAND_NAME` | `Sun Life` | Name shown in the UI and used by the assistant |
| `MCP_CONFIG` | `mcp-servers.json` | MCP server config file |
| `PORT` | `3000` | HTTP port |

## Branding

Colours and font are CSS variables at the top of `public/styles.css`. **The logo is a placeholder** (`public/logo-placeholder.svg`, a generic sun mark). Replace it with the official logo files from your brand team, and swap the font for the licensed brand typeface if you have one.

## Project layout

```
src/
  server.js         Express app: sign-in, chat (Server-Sent Events), static UI; picks the LLM
  agent.js          Claude agent: tool-use loop, shared system prompt, provider setting
  copilotAgent.js   Same agent on the GitHub Copilot SDK (default)
  mcpHub.js         Connects to MCP servers, maps tools, injects customer id
public/             Chat UI (HTML/CSS/JS, vendored marked + DOMPurify)
mock-mcp-servers/   Stand-in policy and claims MCP servers for local testing
data/               Sample customers, policies and claims for the mocks
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
- Add rate limiting and audit logging of tool calls to suit your compliance requirements.

## Contributing

Record every change in [CHANGELOG.md](CHANGELOG.md) under `Unreleased` (or a new version), and keep this README in step with the code.

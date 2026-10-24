# Insurance Customer Chat Agent (Node.js)

A customer-facing chat assistant for an insurance company. A signed-in customer asks about their own policies and claims in plain language; Claude answers by calling tools on your **policy and claims MCP servers**. The chat UI uses a Sun Life-inspired look (yellow on navy, clean type, rounded cards).

```
Browser (chat UI)  ──SSE──►  Express backend  ──►  Claude (Messages API, tool use)
                                   │
                                   └──►  MCP hub ──►  your Policy MCP server
                                                 └──►  your Claims MCP server
```

Built with Node.js 20+, Express, the official [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk) (plus its [Bedrock client](https://www.npmjs.com/package/@anthropic-ai/bedrock-sdk) for AWS) and the official [MCP SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

## Quick start

```bash
npm install
cp .env.example .env            # add ANTHROPIC_API_KEY
node --env-file=.env src/server.js
```

Open http://localhost:3000, pick a demo customer and start chatting.

### Running on AWS (Amazon Bedrock)

If your company uses AWS rather than a direct Claude API key, run Claude through Amazon Bedrock:

```bash
LLM_PROVIDER=bedrock AWS_REGION=us-east-1 node src/server.js
```

- AWS credentials come from the standard AWS chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, an `AWS_PROFILE` from `~/.aws`, or the IAM role of the EC2/ECS/Lambda host. No `ANTHROPIC_API_KEY` is needed.
- In the Bedrock console, make sure model access for Claude Opus 5.5 is enabled in your region. The IAM identity needs permission to invoke it.
- The model defaults to `anthropic.claude-opus-5-5`; override it with `CLAUDE_MODEL` (for example `anthropic.claude-sonnet-5-5` for lower cost).
- The server-side refusal fallback is a Claude API feature and is turned off automatically on Bedrock.

Out of the box `mcp-servers.json` points at two small **mock** MCP servers in `mock-mcp-servers/` (sample data in `data/`) so you can try the app before wiring in your real servers.

### Running on GitHub Copilot (demo option)

If you have a GitHub Copilot subscription but no Claude access, the chat can run on Copilot through the [GitHub Copilot SDK](https://github.com/github/copilot-sdk):

```bash
COPILOT_GITHUB_TOKEN=$(gh auth token) LLM_PROVIDER=copilot node src/server.js
```

- Auth: set `COPILOT_GITHUB_TOKEN` to a GitHub token for an account with Copilot (for example `gh auth token`, or a fine-grained token with the Copilot Requests permission).
- Model: `COPILOT_MODEL` (default `gpt-5`). Any model your Copilot plan offers works, for example `claude-sonnet-4.5`.
- Safety: Copilot's agent is built for coding and normally has file, shell and web tools. This app disables all of them; the session can only call the policy and claims tools, which still go through the same customer-id injection.
- Every customer message counts against that Copilot account's usage. Use this for demos; check GitHub's terms before serving real customers.

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

`${VAR}` values are read from the environment, so URLs and secrets stay out of the file. Tools are discovered automatically at startup and exposed to Claude as `<server>__<tool>`. `GET /api/tools` lists what was found.

### Customer scoping (important)

If a tool has an argument named `customer_id` (configurable via `customerIdArgument`), the backend **removes it from what Claude sees and fills it in from the signed-in session** on every call. Claude can never request another customer's records, even if a user tries to trick it. If your servers identify the customer differently (for example a per-user token), adapt `MCPHub.call` in `src/mcpHub.js`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` (Claude API), `bedrock` (Amazon Bedrock) or `copilot` (GitHub Copilot SDK) |
| `ANTHROPIC_API_KEY` | | Claude API key (not needed on Bedrock) |
| `AWS_REGION` | | Bedrock region, e.g. `us-east-1` |
| `CLAUDE_MODEL` | `claude-opus-5-5` (`anthropic.claude-opus-5-5` on Bedrock) | Model used for the chat |
| `COPILOT_GITHUB_TOKEN` | | GitHub token with Copilot access (only for `copilot`) |
| `COPILOT_MODEL` | `gpt-5` | Copilot model (only for `copilot`) |
| `CLAUDE_EFFORT` | `medium` | `low` is faster and cheaper for simple Q&A |
| `CLAUDE_FALLBACKS` | `true` | Server-side refusal fallback (Claude API only, ignored on Bedrock) |
| `BRAND_NAME` | `Sun Life` | Name shown in the UI and used by the assistant |
| `MCP_CONFIG` | `mcp-servers.json` | MCP server config file |
| `PORT` | `3000` | HTTP port |

## Branding

Colours and font are CSS variables at the top of `public/styles.css`. **The logo is a placeholder** (`public/logo-placeholder.svg`, a generic sun mark). Replace it with the official logo files from your brand team, and swap the font for the licensed brand typeface if you have one.

## Project layout

```
src/
  server.js         Express app: sign-in, chat (Server-Sent Events), static UI
  agent.js          Claude tool-use loop and system prompt
  copilotAgent.js   Same agent on the GitHub Copilot SDK (LLM_PROVIDER=copilot)
  mcpHub.js         Connects to MCP servers, maps tools, injects customer id
public/             Chat UI (HTML/CSS/JS, vendored marked + DOMPurify)
mock-mcp-servers/   Stand-in policy and claims MCP servers for local testing
data/               Sample customers, policies and claims for the mocks
test/               Offline tests (Claude is faked; mock MCP servers run for real)
```

## Tests

```bash
npm test
```

## Before production

- Replace the demo sign-in (`POST /api/session`) with your real customer authentication and derive `customer_id` from the verified identity.
- Move chat sessions from memory to Redis or a database if you run more than one instance.
- Add rate limiting and audit logging of tool calls to suit your compliance requirements.

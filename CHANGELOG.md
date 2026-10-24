# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Removed
- Amazon Bedrock support (`LLM_PROVIDER=bedrock`), its `@anthropic-ai/bedrock-sdk` dependency, test and docs. Copilot covers the "no direct Claude access" case.

### Added
- `CHANGELOG.md` (this file), and a Contributing note in the README to keep it updated.

### Changed
- GitHub Copilot is now the default LLM (`LLM_PROVIDER` defaults to `copilot`); the Claude API stays available with `LLM_PROVIDER=anthropic`. An unknown `LLM_PROVIDER` value now stops the server with a clear error.
- `npm start` and `npm run dev` now load settings from `.env`.
- Node.js requirement set to 20.19+ or 22.12+ (needed by the Copilot SDK).
- Package version set to 0.4.0 to match this changelog.
- README reorganised around a "Choose an LLM" section covering GitHub Copilot and the Claude API, each configured through `.env`.

## [0.4.0] - 2026-10-24

### Added
- GitHub Copilot as an LLM option (`LLM_PROVIDER=copilot`) through the GitHub Copilot SDK (`src/copilotAgent.js`).
  - Copilot's built-in file, shell, web and memory tools are disabled; only the policy and claims tools are available, and any other permission request is refused.
  - The session uses the app's own system prompt and the same customer-id injection as the Claude agent.
  - Signs in with the Copilot CLI account (`copilot login`) by default, or with `COPILOT_GITHUB_TOKEN`.
  - Model set with `COPILOT_MODEL` (default `gpt-5`).
- Tests for the Copilot agent (event streaming, customer scoping, locked-down tool set).

### Changed
- Chat sessions are closed on sign-out, which disconnects the Copilot session when one is open.
- npm `overrides` pin the Copilot SDK's `zod` dependency to the patched version used elsewhere (fixes a high-severity `npm audit` advisory).

## [0.3.0] - 2026-10-23

### Added
- Claude on Amazon Bedrock (`LLM_PROVIDER=bedrock`) using the Anthropic Bedrock client and the standard AWS credential chain. Model defaults to `anthropic.claude-opus-5-5`.
- Test that checks the request sent to Bedrock.

### Changed
- The server-side refusal fallback is turned off automatically on Bedrock, where it isn't available.

## [0.2.0] - 2026-10-23

### Changed
- Rebuilt the app in Node.js: Express backend, Anthropic SDK and MCP SDK. Replaces the earlier Python (FastAPI) prototype.
- Mock MCP servers rewritten in Node.js (`mock-mcp-servers/`).
- Tests use the built-in Node.js test runner (`npm test`).

## [0.1.0] - 2026-10-23

### Added
- Customer chat agent: Claude (Opus 5.5) answers questions about a signed-in customer's policies and claims by calling MCP tools.
- MCP hub that connects to any number of MCP servers (stdio, Streamable HTTP or SSE) listed in a JSON config, with `${VAR}` environment substitution.
- Customer scoping: the `customer_id` tool argument is hidden from the model and filled in from the signed-in session.
- Mock policy and claims MCP servers with sample customers, policies and claims.
- Sun Life-inspired chat UI: demo sign-in, suggested questions, streamed replies, tool activity chips, tables and Markdown, mobile layout. Placeholder logo.
- Offline tests.

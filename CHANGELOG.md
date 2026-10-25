# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- File tools are only sent the file name and type if they have those arguments, so a tool that just takes the contents (set with `uploadArguments`) works.
- Clearer startup messages for your own MCP servers: each server's tool names, which tools take uploaded files (or a warning that none does), and how to fix a `confirm` entry that names a tool your server doesn't have.
- Demo customers and their family members now have English names (for example Emily, James and Lucy Carter, Thomas Wright, Sarah and David Mitchell) in the sample data, tests and docs.

### Added
- `npm run tools` (`scripts/list-tools.mjs`): lists every MCP tool with its arguments, marks customer-scoped, file and confirmation tools, and suggests `uploadArguments` when no tool takes files. Helps set up `confirm` and uploads for real MCP servers.
- "Behind the scenes" panel (header button) showing the technical flow of every message live: a map of the browser, backend, AI model and MCP servers that lights up as each works, and a timeline of steps (message received, each AI request with tool calls and tokens, each MCP call with arguments and result, confirmations) with timings and expandable details. Steps are streamed as `trace` events with the chat (`src/trace.js`). Works with Copilot and the Claude API. Turn off with `SHOW_FLOW=false`.
- Photo and document upload in the chat: a paperclip button next to the message box, thumbnails before sending, and the files shown in the customer's message. JPG, PNG, WebP and PDF, up to 8 MB each and 20 per chat, checked by their contents (`POST /api/upload`).
- Mock claims server tool `attach_claim_document`: attaches a file to a draft (before submission) or a filed claim, matched to a required document. Drafts and claims now list documents received and documents still outstanding; `submit_claim` files the attached documents with the claim.
- File tools in the MCP hub: a tool with a `content_base64` argument gets an `upload_id` argument instead, and the backend fills in the file contents, name and type from the customer's upload. File contents never pass through the LLM, and only files from the same chat can be sent. Argument names can be changed with `uploadArguments` in the MCP config.
- The confirmation card shows which documents are attached and which are still needed.
- The assistant offers to take documents during an accident claim and attaches them. The attachments note tells it which tool takes files (or that none does), and its instructions say it never needs to open a file, so it no longer turns files away or holds up a claim because it "can't read" them.
- `mcp-servers.mock.json` and `test/fixtures/`: the tests use their own mock config and sample data, so editing `mcp-servers.json` or `data/` for a demo no longer breaks them.
- `DEMO_CUSTOMERS` setting for the sign-in list file.
- Tests for uploads and document attachments.
- Accident claims can be filed in the chat.
  - New personal accident policies in the sample data for Emily Carter (`ACC-2020-445210`) and Sarah Mitchell (`ACC-2023-118734`): medical expenses, hospital cash, fracture and accidental death benefits, with a 90-day claim window.
  - Mock claims server tools `create_accident_claim` (draft with checks and estimated payout), `get_claim_draft` and `submit_claim`. Filed claims appear in `list_claims`, `get_claim_status` and `get_claims_summary`.
  - Claim submission guide entry for `accident`.
  - The assistant's instructions cover collecting the claim details step by step and never claiming a claim was filed before it was.
- Customer confirmation for tools that change something (`src/confirmations.js`, `"confirm"` in `mcp-servers.json`). The tool only runs after the customer ticks "true and complete" and presses the button on a confirmation card (`POST /api/confirm`), with both Copilot and Claude.
- Confirmation card in the chat UI: claim summary, benefits and estimated payout, documents needed, attestation checkbox, Submit claim and Cancel.
- Suggested question "I had an accident and want to make a claim".
- Tests for accident claims, the confirmation step and both agents.
- Official logo support: files dropped into `public/brand/` (`logo.*` for the header, `mark.*` for the avatar and browser tab) are picked up automatically, with the placeholder as fallback.
- Brand tagline "Making life brighter" on the sign-in page (`BRAND_TAGLINE`).
- `CHANGELOG.md` (this file), and a Contributing note in the README to keep it updated.

### Removed
- Amazon Bedrock support (`LLM_PROVIDER=bedrock`), its `@anthropic-ai/bedrock-sdk` dependency, test and docs. Copilot covers the "no direct Claude access" case.

### Changed
- The confirmation endpoint now runs the confirmed tool inside the streamed turn, so it shows in the flow panel; a stale card still gets a 409 before anything runs.
- The demo sign-in list reads the customer id from the field named by `customerIdArgument` (e.g. `clientId`), falling back to `customer_id` and then `clientId`, so it works with either config. Customers without an id are left out instead of showing "undefined". The mock servers accept sample data that uses `clientId` too.
- Customer messages can no longer contain the `<system-note>`, `<context>` and `<attachments>` tags the app uses for its own notes to the assistant.
- One reply at a time per conversation: a second message while a reply is streaming gets a "please wait" response.
- Branding updated to the new one-word **Sunlife** brand (announced October 2026): `BRAND_NAME` now defaults to `Sunlife`.
- The header is now white with the yellow underline, so the official logo sits on its intended background.
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

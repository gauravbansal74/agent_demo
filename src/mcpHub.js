// Connects to the configured MCP servers and exposes their tools to Claude.
//
// Servers are listed in a JSON config (MCP_CONFIG, default mcp-servers.json).
// Each entry is one of:
//   { "transport": "stdio", "command": "...", "args": [...], "env": {...} }
//   { "transport": "streamable_http", "url": "...", "headers": {...} }
//   { "transport": "sse", "url": "...", "headers": {...} }
// ${VAR} anywhere in a string value is replaced from the environment, so URLs
// and secrets stay out of the file.
//
// Customer scoping: if a tool's input schema has the argument named by
// customerIdArgument (default "customer_id"), that argument is removed from
// the schema Claude sees and filled in from the signed-in customer on every
// call. Claude cannot ask for another customer's data.
//
// Tools that change something can be listed under "confirm" so they only run after the
// customer presses a confirmation button (see confirmations.js).
//
// File uploads: if a tool's schema has the argument named by uploadArguments.content (default
// "content_base64"), the file arguments (content, file name, MIME type) are replaced by a single
// upload_id in the schema Claude sees. On each call the backend fills them in from a file the
// customer uploaded in this chat, so file contents never pass through the LLM and it can only
// use this customer's own uploads.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolChecks } from "./security.js";
import { clip, noTrace } from "./trace.js";

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
// Claude tool names must match ^[a-zA-Z0-9_-]{1,64}$
const UNSAFE_NAME = /[^a-zA-Z0-9_-]/g;

function expand(value) {
  if (typeof value === "string") return value.replace(ENV_VAR, (_, name) => process.env[name] ?? "");
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

export function loadConfig(file) {
  return expand(JSON.parse(readFileSync(file, "utf8")));
}

function makeTransport(server) {
  const headers = server.headers ?? {};
  switch (server.transport ?? "stdio") {
    case "stdio":
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
        cwd: server.cwd ?? PROJECT_ROOT,
        stderr: "inherit",
      });
    case "streamable_http":
      return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
    case "sse":
      return new SSEClientTransport(new URL(server.url), {
        requestInit: { headers },
        // The SSE stream itself is opened separately, so it needs the headers too.
        eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, ...headers } }) },
      });
    default:
      throw new Error(`Unknown MCP transport ${JSON.stringify(server.transport)}`);
  }
}

export class MCPHub {
  constructor(config) {
    this.config = config;
    this.customerArg = config.customerIdArgument ?? "customer_id";
    this.tools = new Map(); // claude tool name -> { server, client, mcpName, claudeTool, scoped }
    this.confirmations = config.confirm ?? {}; // tool name -> { title, preview }
    this.uploadArgs = { content: "content_base64", fileName: "file_name", mimeType: "mime_type", ...config.uploadArguments };
    this.clients = [];
  }

  async connect() {
    try {
      for (const [name, server] of Object.entries(this.config.servers)) {
        const client = new Client({ name: "insurance-chat-agent", version: "1.0.0" });
        await client.connect(makeTransport(server));
        this.clients.push(client);
        const { tools } = await client.listTools();
        for (const tool of tools) this.#register(name, client, tool);
        console.log(`MCP server "${name}" connected with ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
      }
      for (const [name, rule] of Object.entries(this.confirmations)) {
        for (const tool of [name, rule.preview].filter(Boolean)) {
          if (!this.tools.has(tool)) {
            console.warn(
              `"confirm" in the MCP config names unknown tool ${tool}. Use "<server>__<tool>" with a name from the lists above; run "npm run tools" to see them all.`,
            );
          }
        }
      }
      const files = this.fileTools();
      if (files.length) console.log(`Uploaded files can be sent with: ${files.join(", ")}`);
      else {
        console.warn(
          `No MCP tool takes files, so uploads can't be sent to a claim. A tool needs an argument named "${this.uploadArgs.content}"; if yours is named differently, set "uploadArguments" in the MCP config ("npm run tools" suggests it).`,
        );
      }
    } catch (err) {
      await this.close();
      throw err;
    }
    return this;
  }

  async close() {
    await Promise.allSettled(this.clients.map((c) => c.close()));
    this.clients = [];
  }

  #register(server, client, tool) {
    const schema = structuredClone(tool.inputSchema ?? { type: "object", properties: {} });
    schema.properties ??= {};
    const scoped = this.customerArg in schema.properties;
    if (scoped) {
      delete schema.properties[this.customerArg];
      schema.required = (schema.required ?? []).filter((r) => r !== this.customerArg);
    }
    const takesUpload = this.uploadArgs.content in schema.properties;
    // File name and MIME type are only sent if the tool has those arguments.
    const fileArgs = takesUpload ? Object.values(this.uploadArgs).filter((a) => a in schema.properties) : [];
    if (takesUpload) {
      for (const arg of fileArgs) delete schema.properties[arg];
      schema.properties.upload_id = {
        type: "string",
        description:
          "upload_id of a file the customer uploaded in this chat, from the <attachments> note of their message. The app sends the file's contents for you; you don't need to see or read the file.",
      };
      schema.required = [...(schema.required ?? []).filter((r) => !fileArgs.includes(r)), "upload_id"];
    }
    delete schema.$schema;
    const claudeName = `${server}__${tool.name}`.replace(UNSAFE_NAME, "_").slice(0, 64);
    this.tools.set(claudeName, {
      server,
      client,
      mcpName: tool.name,
      scoped,
      takesUpload,
      fileArgs,
      inputSchema: tool.inputSchema ?? {},
      claudeTool: { name: claudeName, description: tool.description ?? tool.title ?? tool.name, input_schema: schema },
    });
  }

  /** Names of tools that take an uploaded file. */
  fileTools() {
    return [...this.tools.values()].filter((t) => t.takesUpload).map((t) => t.claudeTool.name).sort();
  }

  claudeTools() {
    // Sorted so the tool list is byte-stable across requests (prompt caching).
    return [...this.tools.keys()].sort().map((name) => this.tools.get(name).claudeTool);
  }

  /**
   * Runs a tool. Resolves to { text, isError }.
   * `uploads` is the chat's Map of upload id -> { name, type, data (Buffer) }.
   * `trace` records the call for the "Behind the scenes" panel (see trace.js).
   */
  async call(claudeName, args, customerId, uploads = new Map(), trace = noTrace) {
    const tool = this.tools.get(claudeName);
    if (!tool) return { text: `Unknown tool ${claudeName}`, isError: true };
    const transport = this.config.servers[tool.server]?.transport ?? "stdio";
    toolChecks(trace, {
      server: tool.server,
      transport,
      tool: tool.mcpName,
      scoped: tool.scoped,
      customerArg: this.customerArg,
      customerId,
      takesUpload: tool.takesUpload,
      gated: Boolean(this.confirmations[claudeName]),
    });
    const callArgs = { ...(args ?? {}) };
    // Always the signed-in customer, never the model's choice.
    if (tool.scoped) callArgs[this.customerArg] = customerId;
    if (tool.takesUpload) {
      // Only files uploaded in this chat can be sent.
      const file = uploads.get(String(callArgs.upload_id ?? ""));
      if (!file) return { text: `No file with upload_id ${JSON.stringify(callArgs.upload_id)} was uploaded in this chat`, isError: true };
      delete callArgs.upload_id;
      const values = { [this.uploadArgs.content]: file.data.toString("base64"), [this.uploadArgs.fileName]: file.name, [this.uploadArgs.mimeType]: file.type };
      for (const arg of tool.fileArgs) callArgs[arg] = values[arg];
    }
    const step = trace.start("tool", `MCP ${tool.server} › ${tool.mcpName}`, {
      server: tool.server,
      transport,
      tool: tool.mcpName,
      arguments: tool.takesUpload
        ? { ...callArgs, [this.uploadArgs.content]: `<${callArgs[this.uploadArgs.content].length} base64 characters>` }
        : callArgs,
      added_by_backend: [
        ...(tool.scoped ? [this.customerArg] : []),
        ...tool.fileArgs,
      ],
    });
    try {
      const result = await tool.client.callTool({ name: tool.mcpName, arguments: callArgs });
      const text =
        result.structuredContent !== undefined
          ? JSON.stringify(result.structuredContent)
          : (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      step.end({ status: result.isError ? "error" : "ok", result: clip(text) });
      return { text: text || "(no content)", isError: Boolean(result.isError) };
    } catch (err) {
      // Surface to Claude as a tool error rather than failing the chat.
      console.error(`MCP tool ${claudeName} failed`, err);
      step.end({ status: "error", result: err.message });
      return { text: `Tool call failed: ${err.message}`, isError: true };
    }
  }
}

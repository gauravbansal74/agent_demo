// Test MCP server with a file tool whose arguments aren't the default names. It echoes what it gets.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "file-echo", version: "1.0.0" });
server.registerTool(
  "upload_document",
  { description: "Adds a document to a claim", inputSchema: { clientId: z.string(), claimNumber: z.string(), fileData: z.string() } },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
);
await server.connect(new StdioServerTransport());

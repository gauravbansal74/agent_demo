// Lists the tools on the configured MCP servers and how the app will use them, to help write
// the "confirm" and "uploadArguments" parts of the MCP config.
//   npm run tools        (uses MCP_CONFIG, default mcp-servers.json)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCPHub, loadConfig } from "../src/mcpHub.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = process.env.MCP_CONFIG ?? path.join(ROOT, "mcp-servers.json");
const hub = await new MCPHub(loadConfig(file)).connect();
// Argument names that may hold a file's contents, name or type, for the suggestion below.
const LOOKS_LIKE = {
  content: /base64|content|file_?data|bytes|blob|^data$|^file$/i,
  fileName: /file_?name|filename|^name$/i,
  mimeType: /mime|content_?type|media_?type|file_?type/i,
};

console.log(`\nTools from ${file}\n`);
const suggestions = [];
for (const [name, tool] of hub.tools) {
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const notes = [];
  if (tool.scoped) notes.push(`${hub.customerArg} filled in by the app`);
  if (tool.takesUpload) notes.push(`takes uploaded files (${tool.fileArgs.join(", ")} filled in by the app)`);
  if (hub.confirmations[name]) notes.push("asks the customer to confirm");
  console.log(`${name}${notes.length ? `   [${notes.join("; ")}]` : ""}`);
  for (const [arg, spec] of Object.entries(props)) {
    console.log(`    ${arg}${required.has(arg) ? "*" : ""}: ${spec.type ?? "any"}${spec.format ? ` (${spec.format})` : ""}`);
  }
  if (!tool.takesUpload) {
    const guess = {};
    for (const [key, re] of Object.entries(LOOKS_LIKE)) {
      const arg = Object.keys(props).find((a) => re.test(a) && (props[a].type ?? "string") === "string");
      if (arg) guess[key] = arg;
    }
    if (guess.content) suggestions.push([name, guess]);
  }
}
console.log("\n* required");

const files = hub.fileTools();
if (files.length) console.log(`\nUploaded files can be sent with: ${files.join(", ")}`);
else {
  console.log(`\nNo tool has an argument named "${hub.uploadArgs.content}", so uploads can't be sent to a claim yet.`);
  for (const [name, guess] of suggestions) {
    console.log(`${name} looks like it takes a file. If it does, add this to the MCP config:`);
    console.log(`  "uploadArguments": ${JSON.stringify(guess)}`);
  }
  if (!suggestions.length) console.log("None of the tools looks like it takes a file; the MCP server needs a tool that accepts the file contents (base64).");
}
await hub.close();

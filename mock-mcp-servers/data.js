// Loads the sample JSON data that backs the demo MCP servers.
// These servers are stand-ins: point mcp-servers.json at your real servers instead.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = process.env.INSURANCE_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

export function load(name) {
  const records = JSON.parse(readFileSync(path.join(DATA_DIR, `${name}.json`), "utf8"));
  // Sample data may name the customer field "clientId" instead of "customer_id".
  return records.map((r) => (r.customer_id === undefined && r.clientId !== undefined ? { ...r, customer_id: r.clientId } : r));
}

export const json = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: Array.isArray(value) ? { result: value } : value,
});

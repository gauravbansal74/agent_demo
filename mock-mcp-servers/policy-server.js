// Mock MCP server exposing a customer's insurance policies (stdio).
// Every tool takes customer_id; the chat backend fills it in from the signed-in
// session and hides it from the model.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { json, load } from "./data.js";

const server = new McpServer({ name: "insurance-policies", version: "1.0.0" });
const policies = (customerId) => load("policies").filter((p) => p.customer_id === customerId);
const customerId = z.string().describe("Customer id");

server.registerTool(
  "get_customer_profile",
  {
    description: "Get the customer's profile: name, contact details, province, member-since date and assigned advisor.",
    inputSchema: { customer_id: customerId },
  },
  async ({ customer_id }) =>
    json(load("customers").find((c) => c.customer_id === customer_id) ?? { error: `No customer found with id ${customer_id}` }),
);

server.registerTool(
  "list_policies",
  {
    description: "List the customer's policies with a short summary of each.",
    inputSchema: { customer_id: customerId, status: z.enum(["active", "lapsed"]).optional().describe("Optional status filter") },
  },
  async ({ customer_id, status }) =>
    json(
      policies(customer_id)
        .filter((p) => !status || p.status === status)
        .map((p) => ({
          policy_number: p.policy_number,
          product: p.product,
          type: p.type,
          status: p.status,
          coverage_amount: p.coverage_amount ?? null,
          premium: p.premium,
        })),
    ),
);

server.registerTool(
  "get_policy_details",
  {
    description:
      "Get full details of one policy: coverage, benefits and usage, riders, beneficiaries, premium schedule and key dates.",
    inputSchema: { customer_id: customerId, policy_number: z.string() },
  },
  async ({ customer_id, policy_number }) =>
    json(
      policies(customer_id).find((p) => p.policy_number.toLowerCase() === policy_number.trim().toLowerCase()) ?? {
        error: `Policy ${policy_number} was not found on this customer's account`,
      },
    ),
);

server.registerTool(
  "get_premium_schedule",
  {
    description: "Get upcoming premium payments across all of the customer's active policies, with the monthly total.",
    inputSchema: { customer_id: customerId },
  },
  async ({ customer_id }) => {
    const upcoming = policies(customer_id)
      .filter((p) => p.status === "active")
      .map((p) => ({ policy_number: p.policy_number, product: p.product, ...p.premium }));
    const monthly = upcoming.filter((u) => u.frequency === "monthly").reduce((sum, u) => sum + u.amount, 0);
    return json({ upcoming_payments: upcoming, monthly_total: Math.round(monthly * 100) / 100, currency: "CAD" });
  },
);

await server.connect(new StdioServerTransport());

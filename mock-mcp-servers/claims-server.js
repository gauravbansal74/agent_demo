// Mock MCP server exposing a customer's insurance claims (stdio).
// As with the policy server, customer_id is injected by the chat backend.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { json, load } from "./data.js";

const server = new McpServer({ name: "insurance-claims", version: "1.0.0" });
const STATUSES = ["submitted", "in_review", "paid", "denied"];
const claims = (customerId) => load("claims").filter((c) => c.customer_id === customerId);
const customerId = z.string().describe("Customer id");
const round = (n) => Math.round(n * 100) / 100;

server.registerTool(
  "list_claims",
  {
    description: "List the customer's claims, newest first.",
    inputSchema: {
      customer_id: customerId,
      status: z.enum(STATUSES).optional().describe("Optional status filter"),
      policy_number: z.string().optional().describe("Optional filter to claims made under one policy"),
    },
  },
  async ({ customer_id, status, policy_number }) =>
    json(
      claims(customer_id)
        .filter((c) => !status || c.status === status)
        .filter((c) => !policy_number || c.policy_number.toLowerCase() === policy_number.trim().toLowerCase())
        .sort((a, b) => b.submitted_date.localeCompare(a.submitted_date))
        .map((c) => ({
          claim_id: c.claim_id,
          policy_number: c.policy_number,
          claim_type: c.claim_type,
          status: c.status,
          submitted_date: c.submitted_date,
          amount_claimed: c.amount_claimed,
          amount_paid: c.amount_paid,
        })),
    ),
);

server.registerTool(
  "get_claim_status",
  {
    description:
      "Get full status of one claim: timeline, amounts, outstanding documents, denial reason and appeal deadline if any.",
    inputSchema: { customer_id: customerId, claim_id: z.string() },
  },
  async ({ customer_id, claim_id }) =>
    json(
      claims(customer_id).find((c) => c.claim_id.toLowerCase() === claim_id.trim().toLowerCase()) ?? {
        error: `Claim ${claim_id} was not found on this customer's account`,
      },
    ),
);

server.registerTool(
  "get_claims_summary",
  {
    description:
      "Get totals across the customer's claims: counts by status, total claimed and total paid, and claims needing action.",
    inputSchema: { customer_id: customerId },
  },
  async ({ customer_id }) => {
    const all = claims(customer_id);
    return json({
      counts_by_status: Object.fromEntries(STATUSES.map((s) => [s, all.filter((c) => c.status === s).length])),
      total_claimed: round(all.reduce((sum, c) => sum + c.amount_claimed, 0)),
      total_paid: round(all.reduce((sum, c) => sum + (c.amount_paid ?? 0), 0)),
      currency: "CAD",
      needs_action: all
        .filter((c) => c.outstanding_items?.length)
        .map((c) => ({ claim_id: c.claim_id, outstanding_items: c.outstanding_items })),
    });
  },
);

const common = ["Policy number", "Receipts or invoices showing provider, date and amount"];
const GUIDES = {
  health: [...common, "Prescription receipts with DIN numbers for drug claims"],
  dental: [...common, "Dentist's itemized statement with procedure codes"],
  vision: [...common, "Optometrist prescription dated within the last 24 months"],
  paramedical: [...common, "Practitioner's registration number", "Physician referral if required by your plan"],
  disability: ["Claimant statement", "Attending physician statement", "Employer statement", "Proof of income"],
  critical_illness: ["Claimant statement", "Attending physician statement", "Diagnostic reports (e.g. pathology)"],
  life: ["Claimant statement", "Official death certificate", "Beneficiary identification"],
};

server.registerTool(
  "get_claim_submission_guide",
  {
    description: "Explain how to submit a new claim and which documents are needed.",
    inputSchema: { claim_type: z.string().describe(`One of: ${Object.keys(GUIDES).join(", ")}`) },
  },
  async ({ claim_type }) => {
    const key = claim_type.trim().toLowerCase().replaceAll(" ", "_");
    if (!GUIDES[key]) return json({ error: `Unknown claim type ${claim_type}`, known_types: Object.keys(GUIDES) });
    return json({
      claim_type: key,
      required_documents: GUIDES[key],
      how_to_submit:
        "Submit online or in the mobile app under Claims > Submit a claim. Most health claims are assessed within 5 business days.",
    });
  },
);

await server.connect(new StdioServerTransport());

// Mock MCP server exposing a customer's insurance claims (stdio).
// As with the policy server, customer_id is injected by the chat backend.
// Accident claims can be drafted and submitted; new claims live in memory until the server restarts.
import { createHash, randomInt } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { json, load } from "./data.js";

const server = new McpServer({ name: "insurance-claims", version: "1.0.0" });
const STATUSES = ["submitted", "in_review", "paid", "denied"];
const filed = []; // claims submitted while this server is running
const drafts = new Map(); // draft_id -> draft
const claims = (customerId) => [...load("claims"), ...filed].filter((c) => c.customer_id === customerId);
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
      // Internal file records (hashes) stay on the server; documents_received is the customer-facing list.
      (({ attachments, ...c }) => c)(
        claims(customer_id).find((c) => c.claim_id.toLowerCase() === claim_id.trim().toLowerCase()) ?? {
          error: `Claim ${claim_id} was not found on this customer's account`,
        },
      ),
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
  accident: [
    "Policy number and the date, place and description of the accident",
    "Itemized receipts for accidental medical expenses",
    "Hospital admission and discharge summary for hospital cash",
    "X-ray report confirming a fracture",
    "Police or incident report number if one was made",
  ],
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
    if (key === "accident") {
      return json({
        claim_type: key,
        required_documents: GUIDES[key],
        how_to_submit:
          "Accident claims can be filed right here in the chat (create_accident_claim, then submit_claim), or online or in the mobile app under Claims > Submit a claim. Claims must be filed within the policy's claim window (90 days from the accident). Documents are uploaded after the claim is filed. Accidental death claims are handled by a case manager through customer service or the customer's advisor.",
        information_needed: [
          "Which accident policy",
          "Who was injured (must be a covered member)",
          "Date of the accident",
          "Where it happened",
          "What happened and the injuries",
          "Which benefits apply: medical expenses (amount), hospital stay (days), fracture (minor or major)",
          "Treatment provider (optional) and police report number (optional)",
        ],
      });
    }
    return json({
      claim_type: key,
      required_documents: GUIDES[key],
      how_to_submit:
        "Submit online or in the mobile app under Claims > Submit a claim. Most health claims are assessed within 5 business days.",
    });
  },
);

// ---- Accident claims: draft -> preview -> submit ----

const DAY_MS = 86_400_000;
const money = (n) => `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// MOCK_TODAY lets tests pin the date.
const today = () => process.env.MOCK_TODAY ?? new Date().toISOString().slice(0, 10);
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);
const fail = (error, extra = {}) => json({ error, ...extra });

// Checks the claim against the policy and works out what the policy would pay.
function assessAccident(policy, input) {
  const problems = [];
  const t = today();
  if (!validDate(input.incident_date)) problems.push("incident_date must be a real date in YYYY-MM-DD format");
  else {
    if (input.incident_date > t) problems.push("The accident date can't be in the future");
    if (input.incident_date < policy.effective_date)
      problems.push(`The accident happened before the policy started on ${policy.effective_date}`);
    const age = (Date.parse(t) - Date.parse(input.incident_date)) / DAY_MS;
    if (age > policy.claim_window_days)
      problems.push(`Accident claims must be filed within ${policy.claim_window_days} days; this accident was ${Math.floor(age)} days ago. Please contact customer service.`);
  }
  const member = policy.covered_members.find((m) => m.toLowerCase().startsWith(input.injured_person.trim().toLowerCase()));
  if (!member) problems.push(`${input.injured_person} is not covered by this policy. Covered members: ${policy.covered_members.join(", ")}`);

  const b = policy.benefits;
  const lines = [];
  if (input.medical_expenses_amount !== undefined) {
    const paid = Math.min(input.medical_expenses_amount * (b.medical_expenses.coverage_pct / 100), b.medical_expenses.max_per_accident);
    lines.push({
      benefit: "Accidental medical expenses",
      claimed: input.medical_expenses_amount,
      estimated_payout: paid,
      note: input.medical_expenses_amount > b.medical_expenses.max_per_accident ? `Capped at ${money(b.medical_expenses.max_per_accident)} per accident` : undefined,
    });
  }
  if (input.hospital_days !== undefined) {
    const days = Math.min(input.hospital_days, b.hospital_cash.max_days);
    lines.push({
      benefit: `Hospital cash (${input.hospital_days} day${input.hospital_days === 1 ? "" : "s"})`,
      claimed: input.hospital_days * b.hospital_cash.per_day,
      estimated_payout: days * b.hospital_cash.per_day,
      note: input.hospital_days > b.hospital_cash.max_days ? `Paid for up to ${b.hospital_cash.max_days} days` : undefined,
    });
  }
  if (input.fracture_severity !== undefined) {
    const amount = b.fracture.amounts[input.fracture_severity];
    lines.push({ benefit: `Fracture benefit (${input.fracture_severity})`, claimed: amount, estimated_payout: amount });
  }
  if (!lines.length) problems.push("Choose at least one benefit: medical_expenses_amount, hospital_days or fracture_severity");

  const documents = ["Attending physician's statement"];
  if (input.medical_expenses_amount !== undefined) documents.push("Itemized receipts for the medical expenses");
  if (input.hospital_days !== undefined) documents.push("Hospital admission and discharge summary");
  if (input.fracture_severity !== undefined) documents.push("X-ray report confirming the fracture");
  if (input.police_report_number) documents.push(`Copy of police report ${input.police_report_number}`);
  return { problems, member, lines, documents };
}

function draftView(draft) {
  const { input } = draft;
  return {
    draft_id: draft.draft_id,
    status: draft.status,
    claim_id: draft.claim_id ?? null,
    title: "Accident claim",
    policy: `${draft.policy_product} (${input.policy_number})`,
    summary: [
      ["Injured person", draft.member],
      ["Date of accident", input.incident_date],
      ["Where", input.incident_location],
      ["What happened", input.incident_description],
      ["Injuries", input.injury_description],
      ...(input.treatment_provider ? [["Treated by", input.treatment_provider]] : []),
      ...(input.police_report_number ? [["Police report", input.police_report_number]] : []),
    ].map(([label, value]) => ({ label, value })),
    benefits: draft.lines.map(({ note, ...line }) => (note ? { ...line, note } : line)),
    estimated_total_payout: draft.lines.reduce((sum, l) => sum + l.estimated_payout, 0),
    currency: "CAD",
    required_documents: draft.documents,
    attached_documents: draft.attachments.map(attachmentView),
    outstanding_documents: outstanding(draft.documents, draft.attachments),
    disclaimer: "The payout is an estimate. The final amount is decided after the claim is assessed.",
  };
}

const findDraft = (customer_id, draft_id) => {
  const draft = drafts.get(draft_id.trim().toUpperCase());
  return draft && draft.customer_id === customer_id ? draft : null;
};

server.registerTool(
  "create_accident_claim",
  {
    description:
      "Create a DRAFT accident claim under one of the customer's personal accident policies. Validates the details against the policy and returns a draft_id, a summary, the estimated payout and the documents needed. Nothing is filed until submit_claim is called with the draft_id. Call it again to correct details (it creates a new draft). Accidental death claims cannot be filed here.",
    inputSchema: {
      customer_id: customerId,
      policy_number: z.string().describe("The personal accident policy number"),
      injured_person: z.string().min(2).describe("Name of the injured person; must be a covered member of the policy"),
      incident_date: z.string().describe("Date of the accident, YYYY-MM-DD"),
      incident_location: z.string().min(2).max(200).describe("Where the accident happened"),
      incident_description: z.string().min(5).max(1000).describe("What happened, in the customer's words"),
      injury_description: z.string().min(2).max(500).describe("The injuries"),
      medical_expenses_amount: z.number().positive().max(1_000_000).optional().describe("Total accidental medical expenses in CAD, if claiming them"),
      hospital_days: z.number().int().min(1).max(365).optional().describe("Nights spent in hospital, if claiming hospital cash"),
      fracture_severity: z.enum(["minor", "major"]).optional().describe("If claiming the fracture benefit: minor (finger, toe, rib, wrist, nose) or major (leg, arm, hip, pelvis, skull, spine)"),
      treatment_provider: z.string().max(200).optional().describe("Hospital, clinic or doctor who treated the injury"),
      police_report_number: z.string().max(50).optional().describe("Police or incident report number, if any"),
    },
  },
  async (input) => {
    const policy = load("policies").find(
      (p) => p.customer_id === input.customer_id && p.policy_number.toLowerCase() === input.policy_number.trim().toLowerCase(),
    );
    if (!policy) return fail(`Policy ${input.policy_number} was not found on this customer's account`);
    if (policy.type !== "accident") return fail(`Policy ${policy.policy_number} is not a personal accident policy, so an accident claim can't be filed under it`);
    if (policy.status !== "active") return fail(`Policy ${policy.policy_number} is ${policy.status}, so new claims can't be filed`);

    const { problems, member, lines, documents } = assessAccident(policy, input);
    if (problems.length) return fail("The claim can't be drafted yet", { problems });

    const draft = {
      draft_id: `DRF-${randomInt(100000, 1000000)}`,
      customer_id: input.customer_id,
      status: "draft",
      policy_product: policy.product,
      input: { ...input, policy_number: policy.policy_number },
      member,
      lines,
      documents,
      attachments: [],
    };
    drafts.set(draft.draft_id, draft);
    return json({
      ...draftView(draft),
      next_step:
        "Show the customer this summary and invite them to attach photos or PDFs of the required documents now (paperclip button) with attach_claim_document, or later. Then call submit_claim with the draft_id; the customer confirms in the app.",
    });
  },
);

server.registerTool(
  "get_claim_draft",
  {
    description: "Show a draft claim: its summary, estimated payout, required documents and whether it has been submitted.",
    inputSchema: { customer_id: customerId, draft_id: z.string() },
  },
  async ({ customer_id, draft_id }) => {
    const draft = findDraft(customer_id, draft_id);
    return draft ? json(draftView(draft)) : fail(`Draft ${draft_id} was not found on this customer's account`);
  },
);

// ---- Claim documents ----

const DOCUMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const OTHER_DOCUMENT = "Other supporting document";
const attachmentView = ({ document_type, file_name, mime_type, size_bytes, received_date }) => ({
  document_type,
  file_name,
  mime_type,
  size_bytes,
  received_date,
});
const outstanding = (required, attachments) => required.filter((d) => !attachments.some((a) => a.document_type === d));
// Matches the model's wording to one of the required documents, e.g. "x-ray report" -> "X-ray report confirming the fracture".
function matchDocument(required, documentType) {
  const want = documentType.trim().toLowerCase();
  return required.find((d) => d.toLowerCase() === want) ?? required.find((d) => d.toLowerCase().includes(want) || want.includes(d.toLowerCase())) ?? null;
}
// The file's first bytes must match its type; a real server would also virus-scan and store it.
const SIGNATURES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b.toString("latin1", 1, 4) === "PNG",
  "image/webp": (b) => b.toString("latin1", 8, 12) === "WEBP",
  "application/pdf": (b) => b.toString("latin1", 0, 5) === "%PDF-",
};

server.registerTool(
  "attach_claim_document",
  {
    description:
      "Attach a supporting document (photo or PDF the customer uploaded) to a draft claim (DRF-...) or a filed claim (CLM-...). Use document_type to say which required document it is, using the exact wording from required_documents or outstanding_items. Returns the documents received and those still outstanding.",
    inputSchema: {
      customer_id: customerId,
      claim_reference: z.string().describe("Draft id (DRF-...) or claim number (CLM-...)"),
      document_type: z.string().min(2).max(200).describe("Which required document this file is"),
      file_name: z.string().max(200),
      mime_type: z.string(),
      content_base64: z.string().describe("The file contents, base64-encoded"),
    },
  },
  async ({ customer_id, claim_reference, document_type, file_name, mime_type, content_base64 }) => {
    const ref = claim_reference.trim().toUpperCase();
    const draft = ref.startsWith("DRF-") ? findDraft(customer_id, ref) : null;
    const claim = draft ? null : claims(customer_id).find((c) => c.claim_id === ref);
    if (!draft && !claim) return fail(`${claim_reference} was not found on this customer's account`);
    if (claim && !["submitted", "in_review"].includes(claim.status)) {
      return fail(`Claim ${claim.claim_id} is ${claim.status}, so documents can no longer be added here`);
    }
    if (claim && !filed.includes(claim)) {
      // Sample-data claims are read-only in this mock.
      return fail(`Documents for ${claim.claim_id} can be uploaded in the app under Claims > ${claim.claim_id} > Upload documents`);
    }
    if (!DOCUMENT_TYPES.includes(mime_type)) return fail("Only JPG, PNG, WebP or PDF files can be attached");
    const bytes = Buffer.from(content_base64, "base64");
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) return fail("The file must be between 1 byte and 8 MB");
    if (!SIGNATURES[mime_type](bytes)) return fail(`The file doesn't look like a valid ${mime_type} file`);

    const target = draft ?? claim;
    const required = draft ? draft.documents : claim.required_documents;
    const attachment = {
      document_type: matchDocument(required, document_type) ?? OTHER_DOCUMENT,
      file_name,
      mime_type,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      received_date: today(),
    };
    if (target.attachments.some((a) => a.sha256 === attachment.sha256)) {
      return fail(`${file_name} is already attached to ${ref}`);
    }
    target.attachments.push(attachment);
    if (claim) {
      claim.documents_received = claim.attachments.map(attachmentView);
      claim.outstanding_items = outstanding(claim.required_documents, claim.attachments);
      claim.history.push({ date: attachment.received_date, event: `Document received: ${attachment.document_type}` });
    }
    return json({
      attached_to: ref,
      attached: attachmentView(attachment),
      note: attachment.document_type === OTHER_DOCUMENT ? "Saved as an other supporting document; it didn't match a required document" : undefined,
      documents_received: target.attachments.map(attachmentView),
      outstanding_documents: outstanding(required, target.attachments),
    });
  },
);

server.registerTool(
  "submit_claim",
  {
    description:
      "Submit (file) a draft claim created with create_accident_claim. The customer is asked to review and confirm before it is filed. Returns the new claim number and next steps.",
    inputSchema: { customer_id: customerId, draft_id: z.string() },
  },
  async ({ customer_id, draft_id }) => {
    const draft = findDraft(customer_id, draft_id);
    if (!draft) return fail(`Draft ${draft_id} was not found on this customer's account`);
    if (draft.status === "submitted") return fail(`Draft ${draft.draft_id} was already submitted as claim ${draft.claim_id}`);

    const t = today();
    const { input } = draft;
    const view = draftView(draft);
    const claim = {
      claim_id: `CLM-${t.slice(0, 4)}-${randomInt(100000, 1000000)}`,
      customer_id,
      policy_number: input.policy_number,
      claim_type: `Accident - ${input.injury_description}`,
      status: "submitted",
      submitted_date: t,
      service_date: input.incident_date,
      injured_person: draft.member,
      incident: { location: input.incident_location, description: input.incident_description },
      benefits_claimed: view.benefits,
      amount_claimed: draft.lines.reduce((sum, l) => sum + l.claimed, 0),
      estimated_payout: view.estimated_total_payout,
      amount_approved: null,
      amount_paid: null,
      expected_decision_by: new Date(Date.parse(t) + 14 * DAY_MS).toISOString().slice(0, 10),
      documents_received: draft.attachments.map(attachmentView),
      attachments: draft.attachments,
      required_documents: draft.documents,
      outstanding_items: outstanding(draft.documents, draft.attachments),
      history: [
        { date: t, event: "Claim submitted via chat assistant" },
        ...(draft.attachments.length ? [{ date: t, event: `${draft.attachments.length} document(s) received with the claim` }] : []),
      ],
    };
    filed.push(claim);
    Object.assign(draft, { status: "submitted", claim_id: claim.claim_id });
    return json({
      claim_id: claim.claim_id,
      status: claim.status,
      submitted_date: t,
      estimated_payout: claim.estimated_payout,
      currency: "CAD",
      documents_received: claim.documents_received,
      outstanding_items: claim.outstanding_items,
      next_steps: [
        claim.outstanding_items.length
          ? `Send the remaining documents within 30 days: attach them here in the chat, or in the app under Claims > ${claim.claim_id} > Upload documents`
          : "All required documents were received with the claim",
        "We assess the claim within 10 business days of receiving all documents",
        "Payment goes to the bank account on file by direct deposit",
      ],
      expected_decision_by: claim.expected_decision_by,
    });
  },
);

await server.connect(new StdioServerTransport());

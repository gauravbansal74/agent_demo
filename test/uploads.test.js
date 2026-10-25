import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { InsuranceAgent } from "../src/agent.js";
import { MCPHub } from "../src/mcpHub.js";
import { createApp } from "../src/server.js";
import { FakeClient, message, mockConfig } from "./fakes.js";

let hub, server, base, agent;
before(async () => {
  hub = await new MCPHub(mockConfig()).connect();
  agent = new InsuranceAgent(hub, new FakeClient([]));
  server = createApp(agent).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.close();
  await hub.close();
});

// Smallest valid-looking files for each type.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n");

const post = (url, body) =>
  fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const signIn = async (customer_id = "C1001") => (await (await post("/api/session", { customer_id })).json()).session_id;
const upload = (session_id, data, name, type = "image/jpeg") =>
  fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": type, "X-Session-Id": session_id, "X-File-Name": encodeURIComponent(name) },
    body: data,
  });
const call = async (name, args, customerId = "C1001", uploads) => {
  const { text, isError } = await hub.call(name, args, customerId, uploads);
  return { ...JSON.parse(text), isError };
};
const DRAFT = {
  policy_number: "ACC-2020-445210",
  injured_person: "Lucy",
  incident_date: "2026-10-18",
  incident_location: "Riverside Park, Toronto",
  incident_description: "Fell off her bike",
  injury_description: "Broken left wrist",
  medical_expenses_amount: 1850,
  fracture_severity: "minor",
};

test("file arguments are hidden from the LLM and replaced by upload_id", () => {
  const tool = hub.claudeTools().find((t) => t.name === "claims__attach_claim_document");
  const props = Object.keys(tool.input_schema.properties).sort();
  assert.deepEqual(props, ["claim_reference", "document_type", "upload_id"]);
  assert.ok(tool.input_schema.required.includes("upload_id"));
});

test("uploads are checked by content, not by the name or type the browser sends", async () => {
  const session_id = await signIn();
  const ok = await (await upload(session_id, JPEG, "x-ray.jpg")).json();
  assert.match(ok.upload_id, /^UPL-[0-9a-f]{8}$/);
  assert.equal(ok.type, "image/jpeg");
  // A PDF labelled as a JPEG is stored as what it really is.
  assert.equal((await (await upload(session_id, PDF, "receipt.jpg")).json()).type, "application/pdf");
  assert.equal((await upload(session_id, Buffer.from("MZ not an image"), "evil.png", "image/png")).status, 415);
  assert.equal((await upload("bogus", JPEG, "x.jpg")).status, 401);
  assert.equal((await upload(session_id, Buffer.alloc(9 * 1024 * 1024, 0xff), "big.jpg")).status, 413);
});

test("documents attached to a draft are filed with the claim", async () => {
  const session_id = await signIn();
  const xray = await (await upload(session_id, JPEG, "x-ray.jpg")).json();
  const draft = await call("claims__create_accident_claim", DRAFT);
  assert.deepEqual(draft.attached_documents, []);

  // The agent passes the chat's uploads; the hub fills in the file contents.
  agent.client = new FakeClient([
    message(
      [{ type: "tool_use", id: "tu_1", name: "claims__attach_claim_document", input: { claim_reference: draft.draft_id, document_type: "X-ray report", upload_id: xray.upload_id } }],
      "tool_use",
    ),
    message([{ type: "text", text: "Attached." }], "end_turn"),
  ]);
  await (await post("/api/chat", { session_id, message: "Here's the X-ray", attachments: [xray.upload_id] })).text();
  // The model was told which file came with the message, but not its contents.
  const sent = agent.client.requests[0].messages.at(-1).content;
  assert.match(sent, new RegExp(`<attachments>\\n- upload_id: ${xray.upload_id} \\| x-ray\\.jpg \\| image/jpeg`));
  // ...and how to pass it on, so it doesn't send the customer elsewhere.
  assert.match(sent, /call claims__attach_claim_document with its upload_id; the app sends the file/);
  const toolResult = JSON.parse(agent.client.requests[1].messages.at(-1).content[0].content);
  assert.equal(toolResult.attached.document_type, "X-ray report confirming the fracture");

  const preview = await call("claims__get_claim_draft", { draft_id: draft.draft_id });
  assert.equal(preview.attached_documents.length, 1);
  assert.ok(!preview.outstanding_documents.includes("X-ray report confirming the fracture"));

  const filed = await call("claims__submit_claim", { draft_id: draft.draft_id });
  assert.equal(filed.documents_received[0].file_name, "x-ray.jpg");
  assert.ok(!filed.outstanding_items.includes("X-ray report confirming the fracture"));

  // More documents can follow after filing; the outstanding list shrinks.
  const receipt = await (await upload(session_id, PDF, "receipts.pdf", "application/pdf")).json();
  const convo = { uploads: new Map([[receipt.upload_id, { name: "receipts.pdf", type: "application/pdf", data: PDF }]]) };
  const more = await call(
    "claims__attach_claim_document",
    { claim_reference: filed.claim_id, document_type: "Itemized receipts for the medical expenses", upload_id: receipt.upload_id },
    "C1001",
    convo.uploads,
  );
  assert.equal(more.isError, false);
  const status = await call("claims__get_claim_status", { claim_id: filed.claim_id });
  assert.deepEqual(status.outstanding_items, ["Attending physician's statement"]);
  assert.equal(status.documents_received.length, 2);
  assert.equal(status.attachments, undefined);
});

test("only this chat's uploads can be sent, and only to this customer's claims", async () => {
  const draft = await call("claims__create_accident_claim", DRAFT);
  const missing = await hub.call("claims__attach_claim_document", { claim_reference: draft.draft_id, document_type: "X-ray", upload_id: "UPL-deadbeef" }, "C1001");
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No file with upload_id/);

  const uploads = new Map([["UPL-1", { name: "x.jpg", type: "image/jpeg", data: JPEG }]]);
  const other = await call("claims__attach_claim_document", { claim_reference: draft.draft_id, document_type: "X-ray", upload_id: "UPL-1" }, "C1003", uploads);
  assert.match(other.error, /not found/);
});

test("chat rejects attachment ids that weren't uploaded in this session", async () => {
  const session_id = await signIn();
  const res = await post("/api/chat", { session_id, message: "see attached", attachments: ["UPL-00000000"] });
  assert.equal(res.status, 422);
});

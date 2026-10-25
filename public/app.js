// Chat UI: demo sign-in, then streams assistant replies from /api/chat (Server-Sent Events).
const $ = (id) => document.getElementById(id);
let sessionId = null;
let busy = false;
let brandMark = "/static/logo-placeholder.svg";

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}

async function loadConfig() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  document.querySelectorAll("[data-brand]").forEach((el) => (el.textContent = cfg.brand_name));
  document.querySelectorAll("[data-tagline]").forEach((el) => (el.textContent = cfg.brand_tagline));
  document.title = `${cfg.brand_name} Customer Assistant`;
  brandMark = cfg.brand_mark;
  document.querySelectorAll("[data-brand-mark]").forEach((el) => (el.src = brandMark));
  $("favicon").href = brandMark;
  if (cfg.brand_logo) {
    // The official logo already contains the name, so it replaces the mark + text in the header.
    const logo = $("brand-logo");
    logo.src = cfg.brand_logo;
    logo.alt = cfg.brand_name;
    logo.hidden = false;
    document.querySelector(".brand .brand-mark").hidden = true;
    document.querySelector(".brand .brand-name").hidden = true;
  }
  for (const c of cfg.demo_customers) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${c.name} (${c.customer_id})`;
    b.onclick = () => ($("customer-id").value = c.customer_id);
    $("demo-list").appendChild(b);
  }
  return cfg;
}

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const customerId = $("customer-id").value.trim();
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: customerId }),
  });
  sessionId = (await res.json()).session_id;
  const demo = [...$("demo-list").children].find((b) => b.textContent.endsWith(`(${customerId})`));
  $("greeting").textContent = demo ? `Hi, ${demo.textContent.split(" ")[0]}` : `Customer ${customerId}`;
  $("signin").hidden = true;
  $("chat").hidden = false;
  $("userbar").hidden = false;
  $("input").focus();
});

$("signout").addEventListener("click", async () => {
  if (sessionId) await fetch(`/api/session/${sessionId}`, { method: "DELETE" });
  location.reload();
});

$("suggestions").addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") send(e.target.textContent);
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("input").value);
});

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send($("input").value);
  }
});
$("input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = `${e.target.scrollHeight}px`;
});

function addMessage(role) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  if (role === "bot") {
    msg.innerHTML = `<div class="avatar" aria-hidden="true"><img src="${brandMark}" alt=""></div>`;
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  msg.appendChild(bubble);
  $("messages").appendChild(msg);
  return bubble;
}

function scrollDown() {
  $("messages").scrollTop = $("messages").scrollHeight;
}

function setBusy(value) {
  busy = value;
  $("send").disabled = value;
  if (!value) $("input").focus();
}

/** Adds a bot bubble and fills it from an SSE response (POST url with body). */
async function streamReply(url, body, { onConfirmed } = {}) {
  const bubble = addMessage("bot");
  bubble.innerHTML = `<div class="activity"></div><div class="content"><span class="typing"><span></span><span></span><span></span></span></div>`;
  const activity = bubble.querySelector(".activity");
  const content = bubble.querySelector(".content");
  scrollDown();

  let answer = "";
  const showText = () => (content.innerHTML = renderMarkdown(answer));
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 401) throw new Error("Your session has expired. Please sign out and sign in again.");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? "Something went wrong. Please try again.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const event = JSON.parse(part.slice(6));
        if (event.type === "text") {
          answer += event.text;
          showText();
        } else if (event.type === "tool") {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = event.label;
          activity.appendChild(chip);
        } else if (event.type === "confirm") {
          bubble.appendChild(confirmCard(event));
        } else if (event.type === "confirmed") {
          onConfirmed?.(event);
        } else if (event.type === "error") {
          answer += (answer ? "\n\n" : "") + event.text;
          showText();
          bubble.classList.add("error");
        } else if (event.type === "done" && !answer) {
          content.remove();
        }
        scrollDown();
      }
    }
  } catch (err) {
    content.textContent = err.message;
    bubble.classList.add("error");
  }
}

async function send(text) {
  text = text.trim();
  // Wait for uploads in progress; files that failed are dropped.
  if (busy || pending.some((f) => !f.id && !f.error)) return;
  const files = pending.splice(0).filter((f) => f.id);
  if (!text && !files.length) return;
  renderTray();
  setBusy(true);
  $("input").value = "";
  $("input").style.height = "auto";
  const bubble = addMessage("user");
  if (files.length) bubble.append(fileStrip(files));
  if (text) bubble.append(el("div", "", text));
  try {
    await streamReply("/api/chat", { session_id: sessionId, message: text, attachments: files.map((f) => f.id) });
  } finally {
    setBusy(false);
  }
}

// ---- File attachments (claim documents) ----
// Files upload as soon as they're picked, then go with the next message as upload ids.
const pending = []; // { file, url, id?, error? }
const MAX_FILE_BYTES = 8 * 1024 * 1024;

$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  for (const file of e.target.files) upload(file);
  e.target.value = "";
});

async function upload(file) {
  const item = { file, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null };
  pending.push(item);
  if (file.size > MAX_FILE_BYTES) item.error = "Over 8 MB";
  renderTray();
  if (item.error) return;
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-Session-Id": sessionId, "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Upload failed");
    item.id = body.upload_id;
  } catch (err) {
    item.error = err.message;
  }
  renderTray();
}

function fileThumb(item, onRemove) {
  const tile = el("div", `file${item.error ? " failed" : ""}${item.id || item.error ? "" : " uploading"}`);
  tile.title = item.error ? `${item.file.name}: ${item.error}` : item.file.name;
  if (item.error) tile.append(el("span", "file-icon", "!"));
  else if (item.url) {
    const img = el("img");
    img.src = item.url;
    img.alt = "";
    tile.append(img);
  } else tile.append(el("span", "file-icon", "PDF"));
  const label = el("span", "file-name", item.file.name);
  if (item.error) label.append(el("small", "", item.error));
  tile.append(label);
  if (onRemove) {
    const x = el("button", "file-remove", "×");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${item.file.name}`);
    x.onclick = onRemove;
    tile.append(x);
  }
  return tile;
}

function renderTray() {
  const tray = $("tray");
  tray.replaceChildren(
    ...pending.map((item, i) =>
      fileThumb(item, () => {
        pending.splice(i, 1);
        renderTray();
      }),
    ),
  );
  tray.hidden = !pending.length;
}

const fileStrip = (files) => {
  const strip = el("div", "file-strip");
  strip.append(...files.map((f) => fileThumb(f)));
  return strip;
};

const money = (n, currency = "CAD") =>
  Number(n).toLocaleString("en-CA", { style: "currency", currency, currencyDisplay: "narrowSymbol" });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Confirmation card for an action the assistant prepared (e.g. a claim). Nothing happens until the customer presses confirm. */
function confirmCard(event) {
  const p = event.preview ?? {};
  const card = el("div", "confirm-card");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", event.title);

  const head = el("div", "confirm-head");
  head.append(el("strong", "", event.title));
  if (p.title || p.policy) head.append(el("span", "", [p.title, p.policy].filter(Boolean).join(" · ")));
  card.append(head);

  const rows = p.summary ?? Object.entries(p).filter(([, v]) => typeof v !== "object").map(([label, value]) => ({ label, value }));
  if (rows.length) {
    const dl = el("dl", "confirm-rows");
    for (const { label, value } of rows) dl.append(el("dt", "", label), el("dd", "", String(value)));
    card.append(dl);
  }

  if (p.benefits?.length) {
    const table = el("table", "confirm-benefits");
    table.innerHTML = "<thead><tr><th>Benefit</th><th>Estimated payout</th></tr></thead>";
    const tbody = el("tbody");
    for (const b of p.benefits) {
      const tr = el("tr");
      const name = el("td", "", b.benefit);
      if (b.note) name.append(el("small", "", b.note));
      tr.append(name, el("td", "num", money(b.estimated_payout, p.currency)));
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(table);
  }
  if (p.estimated_total_payout !== undefined) {
    const total = el("div", "confirm-total", "Estimated total ");
    total.append(el("strong", "", money(p.estimated_total_payout, p.currency)));
    card.append(total);
  }
  if (p.disclaimer) card.append(el("p", "confirm-note", p.disclaimer));
  if (p.required_documents?.length) {
    const attached = p.attached_documents ?? [];
    const missing = p.outstanding_documents ?? p.required_documents;
    const docs = el("details", "confirm-docs");
    docs.open = attached.length > 0;
    docs.append(el("summary", "", `Documents: ${attached.length} attached, ${missing.length} still needed`));
    const ul = el("ul");
    for (const a of attached) ul.append(el("li", "doc-ok", `${a.document_type} (${a.file_name})`));
    for (const d of missing) ul.append(el("li", "doc-missing", d));
    docs.append(ul);
    if (missing.length) docs.append(el("p", "confirm-note", "You can send these later, here in the chat or in the app."));
    card.append(docs);
  }

  const attest = el("label", "confirm-attest");
  const box = el("input");
  box.type = "checkbox";
  attest.append(box, el("span", "", "I confirm this information is true and complete."));
  const cancel = el("button", "btn-secondary", "Cancel");
  const ok = el("button", "btn-primary", event.confirm_label ?? "Confirm");
  cancel.type = ok.type = "button";
  ok.disabled = true;
  box.onchange = () => (ok.disabled = !box.checked);
  const actions = el("div", "confirm-actions");
  actions.append(cancel, ok);
  const status = el("div", "confirm-status");
  status.hidden = true;
  card.append(attest, actions, status);

  const answer = async (approved) => {
    if (busy) return;
    setBusy(true);
    box.disabled = ok.disabled = cancel.disabled = true;
    addMessage("user").textContent = approved ? `${event.confirm_label ?? "Confirm"} ✓` : "Cancel";
    const finish = (text, kind) => {
      card.classList.add("done", kind);
      attest.hidden = actions.hidden = true;
      status.textContent = text;
      status.hidden = false;
    };
    try {
      await streamReply(
        "/api/confirm",
        { session_id: sessionId, confirmation_id: event.id, approved, attested: box.checked },
        {
          onConfirmed: (e) => {
            if (e.outcome === "done") finish(`Submitted${e.result?.claim_id ? ` · ${e.result.claim_id}` : ""}`, "ok");
            else if (e.outcome === "cancelled") finish("Cancelled", "cancelled");
            else finish("Not submitted", "failed");
          },
        },
      );
    } finally {
      // Card still open (e.g. expired request): let the customer try again or move on.
      if (!card.classList.contains("done")) {
        box.disabled = cancel.disabled = false;
        ok.disabled = !box.checked;
      }
      setBusy(false);
    }
  };
  ok.onclick = () => answer(true);
  cancel.onclick = () => answer(false);
  return card;
}

loadConfig();

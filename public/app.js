// Chat UI: demo sign-in, then streams assistant replies from /api/chat (Server-Sent Events).
const $ = (id) => document.getElementById(id);
let sessionId = null;
let busy = false;

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}

async function loadConfig() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  document.querySelectorAll("[data-brand]").forEach((el) => (el.textContent = cfg.brand_name));
  document.title = `${cfg.brand_name} Customer Assistant`;
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
    msg.innerHTML = `<div class="avatar" aria-hidden="true"><img src="/static/logo-placeholder.svg" alt=""></div>`;
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

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  $("send").disabled = true;
  $("input").value = "";
  $("input").style.height = "auto";

  addMessage("user").textContent = text;
  const bubble = addMessage("bot");
  bubble.innerHTML = `<div class="activity"></div><div class="content"><span class="typing"><span></span><span></span><span></span></span></div>`;
  const activity = bubble.querySelector(".activity");
  const content = bubble.querySelector(".content");
  scrollDown();

  let answer = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text }),
    });
    if (res.status === 401) throw new Error("Your session has expired. Please sign out and sign in again.");
    if (!res.ok) throw new Error("Something went wrong. Please try again.");

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
          content.innerHTML = renderMarkdown(answer);
        } else if (event.type === "tool") {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = event.label;
          activity.appendChild(chip);
        } else if (event.type === "error") {
          answer += (answer ? "\n\n" : "") + event.text;
          content.innerHTML = renderMarkdown(answer);
          bubble.classList.add("error");
        }
        scrollDown();
      }
    }
  } catch (err) {
    content.textContent = err.message;
    bubble.classList.add("error");
  } finally {
    busy = false;
    $("send").disabled = false;
    $("input").focus();
  }
}

loadConfig();

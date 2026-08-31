// Client for the kitchen-sink UI. Talks only to the Sproutboat worker's JSON
// routes; every fetch here exercises a binding on the server side.

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

type Json = Record<string, unknown>;

async function j(path: string, opts?: RequestInit): Promise<any> {
  const r = await fetch(path, opts);
  const t = await r.text();
  let b: unknown;
  try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error((b && (b as Json).error as string) || r.statusText);
  return b;
}

/* ---- tabs ---- */
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("nav.tabs button"));
function showTab(name: string): void {
  let known = false;
  for (const b of tabButtons) {
    const on = b.dataset.tab === name;
    known = known || on;
    b.classList.toggle("active", on);
  }
  if (!known) name = "notes";
  for (const p of document.querySelectorAll<HTMLElement>(".panel")) p.hidden = p.id !== "tab-" + name;
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "attachments") void loadAttachments();
  if (name === "outbound") void loadQuote();
  if (name === "admin" && adminToken) void fetchStats(adminToken).catch(() => {});
}
tabButtons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab || "notes")));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

/* ---- session (KV) — login lives in the header ---- */
let token: string | null = null;
$("#login").addEventListener("click", async () => {
  try {
    const r = await j("/login", { method: "POST" });
    token = r.token;
    const me = await j("/whoami", { headers: { authorization: "Bearer " + token } });
    ($("#login") as HTMLButtonElement).textContent = "Log in again";
    $("#who").textContent = `${me.user} · token ${String(token).slice(0, 8)}… in KV`;
  } catch (e) { $("#who").textContent = (e as Error).message; }
});

/* ---- notes (D1 + DO + Queue + R2 upload) ---- */
async function loadNotes(): Promise<void> {
  const err = $("#notes-err"); err.textContent = "";
  try {
    const notes = await j("/notes");
    const ul = $("#notes-list");
    ul.innerHTML = "";
    for (const n of notes) {
      const li = document.createElement("li");
      li.innerHTML = `<h3></h3><div class="meta"></div>`;
      (li.querySelector("h3") as HTMLElement).textContent = n.title;
      (li.querySelector(".meta") as HTMLElement).textContent =
        `#${n.id} · ${new Date(n.created).toLocaleString()}` + (n.attachment ? ` · 📎 ${n.attachment}` : "");
      li.addEventListener("click", () => openNote(li, n.id));
      ul.append(li);
    }
  } catch (e) { err.textContent = (e as Error).message; }
}

async function openNote(li: HTMLElement, id: number): Promise<void> {
  const existing = li.querySelector(".detail");
  if (existing) { existing.remove(); return; }
  const full = await j(`/notes/${id}`);
  const d = document.createElement("div");
  d.className = "detail";
  d.innerHTML = `<p class="body"></p><div class="meta">Durable Object view count: <b>${full.views}</b></div>`;
  (d.querySelector(".body") as HTMLElement).textContent = full.note.body || "(no body)";
  if (full.note.attachment) {
    const a = document.createElement("a");
    a.href = "/attach/" + encodeURIComponent(full.note.attachment);
    a.textContent = "download attachment (R2 get)";
    d.append(a);
  }
  li.append(d);
}

const MAX_UPLOAD = 900 * 1024; // native-fetch server caps an inbound body at 1 MiB (issue #56)

$("#new-note").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target as HTMLFormElement;
  const err = $("#notes-err"); err.textContent = "";
  const ok = $("#notes-ok"); ok.textContent = "";
  const file = ($("#new-file") as HTMLInputElement).files?.[0];
  if (file && file.size > MAX_UPLOAD) {
    err.textContent = `file is ${(file.size / 1024).toFixed(0)} KB — the demo caps R2 uploads at ~900 KB (large-object R2 is tracked in issue #56)`;
    return;
  }
  try {
    const title = (f.elements.namedItem("title") as HTMLInputElement).value;
    const body = (f.elements.namedItem("body") as HTMLTextAreaElement).value;
    const created = await j("/notes", { method: "POST", body: JSON.stringify({ title, body }) });
    if (!created || typeof created.id !== "number") throw new Error("note create returned no id");
    let msg = `note #${created.id} created`;
    if (file) {
      const r = await fetch(`/notes/${created.id}/attach`, { method: "POST", body: await file.text() });
      const rb = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`attach failed (${r.status}): ${rb.error || "see server logs"}`);
      msg += ` · attached ${rb.key} to R2`;
      await loadAttachments();
    }
    ok.textContent = msg;
    f.reset(); ($("#new-file") as HTMLInputElement).value = "";
    await loadNotes();
  } catch (e) { err.textContent = (e as Error).message; }
});

/* ---- attachments (R2) ---- */
async function loadAttachments(): Promise<void> {
  const tb = $("#att-table tbody");
  try {
    const rows = await j("/attachments");
    tb.innerHTML = "";
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="4" class="muted">no objects yet — attach a file from the Notes tab</td></tr>`; return; }
    for (const o of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td></td><td>${o.size} B</td><td>${new Date(o.uploaded).toLocaleTimeString()}</td>` +
        `<td><a href="/attach/${encodeURIComponent(o.key)}">download</a></td>`;
      (tr.children[0] as HTMLElement).textContent = o.key;
      tb.append(tr);
    }
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="4" class="err">${(e as Error).message}</td></tr>`;
  }
}
$("#refresh-att").addEventListener("click", () => void loadAttachments());

/* ---- outbound fetch ---- */
async function loadQuote(): Promise<void> {
  try {
    const q = await j("/quote");
    $("#quote").textContent = `“${q.content}” `;
    const by = document.createElement("span");
    by.className = "by";
    by.textContent = `— ${q.author}`;
    $("#quote").append(by);
  } catch { $("#quote").textContent = "(outbound fetch unavailable)"; }
}
$("#refresh-quote").addEventListener("click", () => void loadQuote());

/* ---- admin dashboard (secret + Analytics + cron) ---- */
let adminToken: string | null = null;
let adminTimer: ReturnType<typeof setInterval> | null = null;

$("#admin-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pw = ($("#admin-pw") as HTMLInputElement).value;
  $("#admin-err").textContent = "";
  try {
    await fetchStats(pw);
    adminToken = pw;
    $("#admin-state").textContent = "unlocked · refreshing every 3s";
    ($("#admin-body") as HTMLElement).hidden = false;
    if (adminTimer) clearInterval(adminTimer);
    adminTimer = setInterval(() => void fetchStats(adminToken as string).catch(() => {}), 3000);
  } catch (e) {
    $("#admin-err").textContent = /forbidden/i.test((e as Error).message) ? "wrong password" : (e as Error).message;
  }
});

async function fetchStats(pw: string): Promise<void> {
  const r = await fetch("/admin/stats", { headers: { "x-admin-token": pw } });
  if (r.status === 403) throw new Error("forbidden");
  const s = await r.json();
  const tiles: Array<[string, unknown]> = [
    ["KV sessions", s.kv_sessions],
    ["D1 notes", s.d1_notes],
    ["R2 objects", s.r2_objects],
    ["Queue emails", s.queue_emails_processed],
    ["Cron heartbeats", s.cron_heartbeats],
    ["Analytics points", s.analytics_points],
  ];
  $("#tiles").innerHTML = tiles.map(([k, n]) => `<div class="tile"><div class="n">${n}</div><div class="k">${k}</div></div>`).join("");
  const box = $("#events");
  box.innerHTML = `<b>recent analytics events</b> · last heartbeat ${s.last_heartbeat ? new Date(s.last_heartbeat.at).toLocaleTimeString() : "—"}`;
  for (const e of s.analytics_recent) {
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = `${new Date(e.at).toLocaleTimeString()}  ${e.method}  ${e.path}`;
    box.append(line);
  }
}

/* ---- boot ---- */
showTab((location.hash || "#notes").slice(1));
void loadNotes();

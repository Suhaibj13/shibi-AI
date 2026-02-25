// GAIA chat front-end (multi-chat + model picker). Only 'grok' calls backend.
// This version keeps the composer merged with the chat by syncing a CSS var.

(() => {
  const $ = s => document.querySelector(s);

  // DOM refs
  const messagesEl = $("#messages");
  const inputEl = $("#input");


// --- Auth state (Mark2) ---
let GAIA_ID_TOKEN = localStorage.getItem("gaia_id_token") || "";
let GAIA_USER = null;

async function gaiaFetch(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  // Preserve FormData boundary: don't set content-type for FormData
  if (GAIA_ID_TOKEN) headers.set("Authorization", "Bearer " + GAIA_ID_TOKEN);
  return fetch(url, { ...opts, headers });
}

async function gaiaJson(url, opts = {}) {
  const res = await gaiaFetch(url, opts);

  // 🔐 AUTH ENFORCEMENT HANDLING
  if (res.status === 401) {
    GAIA_ID_TOKEN = "";
    GAIA_USER = null;
    localStorage.removeItem("gaia_id_token");

    if (typeof openAuthModal === "function") {
      openAuthModal();
    }

    return { res, data: { ok: false, error: "auth_required" } };
  }

  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function gaiaAfterLogin() {
  const { data } = await gaiaJson("/api/me");
  GAIA_USER = data?.user || null;
  // Best-effort server sync; falls back to local if endpoints unavailable
  try { await gaiaLoadChatsFromServer(); } catch (_) {}
  updateAuthButton();
}

async function gaiaAfterLogout() {
  GAIA_ID_TOKEN = "";
  GAIA_USER = null;
  localStorage.removeItem("gaia_id_token");
  updateAuthButton();
}

function updateAuthButton() {
  const btn = document.getElementById("auth-btn");
  if (!btn) return;
  btn.title = GAIA_ID_TOKEN ? "Account" : "Login";
  btn.setAttribute("aria-label", GAIA_ID_TOKEN ? "Account" : "Login");
}

// Optional: load chats/messages from server and hydrate existing local renderer
async function gaiaLoadChatsFromServer() {
  if (!GAIA_ID_TOKEN) return;
  const { data } = await gaiaJson("/api/chats");
  if (!data?.ok) return;
  const serverChats = data.data || [];

  const mapped = serverChats.map(c => ({
    id: c.id,
    title: c.title || "Chat",
    history: [],
    stats: { in_tokens: 0, out_tokens: 0, total_tokens: 0 },
    branch: { active: 1 },
    meta: { server: true }
  }));

  localStorage.setItem("gaia_chats_v2", JSON.stringify(mapped));

  // Ensure current chat
  if (!window.currentId && mapped[0]) window.currentId = mapped[0].id;

  if (window.currentId) {
    await gaiaLoadMessagesForChat(window.currentId);
  }

  if (typeof renderChatList === "function") renderChatList();
  if (typeof renderChat === "function") renderChat();
}

async function gaiaLoadMessagesForChat(chatId) {
  if (!GAIA_ID_TOKEN || !chatId) return;
  const { data } = await gaiaJson(`/api/chats/${encodeURIComponent(chatId)}/messages`);
  if (!data?.ok) return;
  const msgs = data.data || [];
  const chat = (typeof getChat === "function") ? getChat(chatId) : null;
  if (!chat) return;
  chat.history = msgs.map(m => ({
    role: m.role,
    content: m.content,
    meta: m.meta || null,
    time: Date.now()
  }));
  if (typeof updateChat === "function") updateChat(chat);
}

function openAuthModal() {
  const tpl = document.getElementById("auth-modal-template");
  const modal = document.getElementById("gaia-modal");
  const title = document.getElementById("gaia-modal-title");
  const body = document.getElementById("gaia-modal-body");
  const okBtn = document.getElementById("gaia-modal-ok");
  if (!tpl || !modal || !title || !body) return;

  title.textContent = "Sign in to GAIA";
  body.innerHTML = "";
  body.appendChild(tpl.content.cloneNode(true));
  if (okBtn) okBtn.style.display = "none";
  modal.classList.add("is-open");

  const tabs = Array.from(body.querySelectorAll(".auth-tab"));
  const panes = Array.from(body.querySelectorAll(".auth-pane"));
  const fb = window.__GAIA_FB;
  const cfg = window.GAIA_FIREBASE_CONFIG;

  function setTab(name) {
    tabs.forEach(t => t.classList.toggle("is-active", t.dataset.tab === name));
    panes.forEach(p => p.hidden = (p.dataset.pane !== name));
  }
  tabs.forEach(t => t.addEventListener("click", () => setTab(t.dataset.tab)));
  setTab("email");

  const emailEl = body.querySelector("#auth-email");
  const passEl = body.querySelector("#auth-pass");
  const msgEmail = body.querySelector("#auth-msg-email");
  const msgGoogle = body.querySelector("#auth-msg-google");
  const logoutBtn = body.querySelector("#auth-logout");

  const setMsg = (el, t) => { if (el) el.textContent = t || ""; };

  if (!fb || !cfg || !cfg.apiKey) {
    setMsg(msgEmail, "Auth is not configured. Add GAIA_FIREBASE_CONFIG + Firebase SDK scripts in index.html.");
    return;
  }

  const app = fb.initializeApp(cfg);
  const auth = fb.getAuth(app);

  body.querySelector("#auth-signin")?.addEventListener("click", async () => {
    setMsg(msgEmail, "");
    try {
      const cred = await fb.signInWithEmailAndPassword(auth, (emailEl.value||"").trim(), passEl.value||"");
      const tok = await cred.user.getIdToken(true);
      GAIA_ID_TOKEN = tok;
      localStorage.setItem("gaia_id_token", tok);
      modal.classList.remove("is-open");
      await gaiaAfterLogin();
    } catch (e) {
      setMsg(msgEmail, e?.message || "Sign in failed");
    }
  });

  body.querySelector("#auth-signup")?.addEventListener("click", async () => {
    setMsg(msgEmail, "");
    try {
      const cred = await fb.createUserWithEmailAndPassword(auth, (emailEl.value||"").trim(), passEl.value||"");
      const tok = await cred.user.getIdToken(true);
      GAIA_ID_TOKEN = tok;
      localStorage.setItem("gaia_id_token", tok);
      modal.classList.remove("is-open");
      await gaiaAfterLogin();
    } catch (e) {
      setMsg(msgEmail, e?.message || "Sign up failed");
    }
  });

  body.querySelector("#auth-google")?.addEventListener("click", async () => {
    setMsg(msgGoogle, "");
    try {
      const provider = new fb.GoogleAuthProvider();
      const cred = await fb.signInWithPopup(auth, provider);
      const tok = await cred.user.getIdToken(true);
      GAIA_ID_TOKEN = tok;
      localStorage.setItem("gaia_id_token", tok);
      modal.classList.remove("is-open");
      await gaiaAfterLogin();
    } catch (e) {
      setMsg(msgGoogle, e?.message || "Google sign in failed");
    }
  });

  if (GAIA_ID_TOKEN && logoutBtn) {
    logoutBtn.hidden = false;
    logoutBtn.addEventListener("click", async () => {
      try { await fb.signOut(auth); } catch (_) {}
      modal.classList.remove("is-open");
      await gaiaAfterLogout();
    });
  }
}

// Wire auth button if present
document.getElementById("auth-btn")?.addEventListener("click", openAuthModal);
updateAuthButton();
if (GAIA_ID_TOKEN) { gaiaAfterLogin().catch(()=>{}); }

  const sendBtn = $("#send");
  const modelSel = $("#model");
  const versionSel = document.getElementById("model-version");
  let _mvReqSeq = 0; // guards against out-of-order /models/versions responses
  const statusEl = $("#status");
  const chatListEl = $("#chat-list");
  const newChatBtn = $("#new-chat");
  const clearAllBtn = $("#clear-all");
  const moreBtn = $("#more");
    // --- GAIA V5 minimal: + menu (no layout changes) ---
  const fileInput = document.getElementById("file-input");
  const plusMenu  = document.getElementById("plus-menu");
  const plusUploadBtn = document.getElementById("plus-upload");
  const plusComingBtn = document.getElementById("plus-coming");

  let PENDING_FILES = []; // cleared after successful send
  let currentSSE = null;
  let GAIA_BUSY = false;
  
    // Limits
  const MAX_FILES = 5;
  const MAX_TOTAL_MB = 50;

  function bytesTotal(list) {
    return (list || []).reduce((s, f) => s + (f?.size || 0), 0);
  }

  // Try to add a batch of files without exceeding limits

  function hasAttachments(){
    // Adjust according to your app; both checks are safe
    if (window.GAIA_FILES && window.GAIA_FILES.length) return true;
    const vaultItems = document.querySelectorAll('#vault-list .vault-item');
    return vaultItems && vaultItems.length > 0;
  }

  function tryAddFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    let current = PENDING_FILES.slice();
    let added = 0;

    for (const f of incoming) {
      const tooMany = current.length >= MAX_FILES;
      const tooBig  = (bytesTotal(current) + f.size) > (MAX_TOTAL_MB * 1024 * 1024);
      if (tooMany || tooBig) {
        // minimal UX: tell the user and stop adding
        alert(`Attachment limit reached.
  - Max files: ${MAX_FILES}
  - Max total size: ${MAX_TOTAL_MB} MB`);
        break;
      }
      current.push(f);
      added++;
    }

    if (added > 0) {
      PENDING_FILES = current;
      updateChips();
    }

    // allow picking the same file again later
    if (fileInput) fileInput.value = "";
  }
  
  // --- Chips: icon + renderer ---
  const chipsHost = document.getElementById("attach-chips");

  function iconForFile(name = "", type = "") {
    const n = name.toLowerCase();
    if (type.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp|svg)$/.test(n)) return "🖼️";
    if (/\.pdf$/.test(n)) return "📄";
    if (/\.(xls|xlsx|csv|tsv|ods)$/.test(n)) return "📈";
    if (/\.(doc|docx)$/.test(n)) return "📝";
    if (/\.(ppt|pptx)$/.test(n)) return "📊";
    if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return "🗜️";
    if (/\.(txt|md|log|json|yaml|yml|xml)$/.test(n) || type.startsWith("text/")) return "📜";
    return "📎";
  }

  function updateChips() {
    if (!chipsHost) return;
    chipsHost.innerHTML = "";
    if (!PENDING_FILES || PENDING_FILES.length === 0) {
      chipsHost.setAttribute("hidden", "");
      return;
    }
    chipsHost.removeAttribute("hidden");

    PENDING_FILES.forEach((f, idx) => {
      const el = document.createElement("div");
      el.className = "attach-chip";
      el.innerHTML = `
        <span class="ac-ico-wrap">
          <span class="ac-icon">${iconForFile(f.name, f.type)}</span>
          <button class="ac-x" title="Remove ${f.name}" aria-label="Remove ${f.name}">×</button>
        </span>
        <span class="ac-name" title="${f.name}">${f.name}</span>
      `;
      el.querySelector(".ac-x").addEventListener("click", (ev) => {
        ev.stopPropagation();
        // remove this file from the pending list
        PENDING_FILES.splice(idx, 1);
        if (PENDING_FILES.length === 0 && fileInput) {
          fileInput.value = ""; // fully clear the picker
        }
        updateChips(); // re-render chips
      });
      chipsHost.appendChild(el);
    });
    positionChipsToInput();
  }

  function positionChipsToInput() {
    if (!chipsHost) return;
    if (chipsHost.hasAttribute("hidden")) return;

    const bar = document.getElementById("chatbar");
    const input = document.getElementById("input");
    if (!bar || !input) return;

    const barRect = bar.getBoundingClientRect();
    const inRect  = input.getBoundingClientRect();

    // Align the chips’ left edge with the textarea’s left edge
    const leftPx = inRect.left - barRect.left;
    chipsHost.style.left = leftPx + "px";

    // Constrain chips to the textarea width (so they don’t run under the send/controls)
    const maxW = inRect.width;
    chipsHost.style.maxWidth = maxW + "px";
  }


  // Try a few common selectors to find the last user bubble
  function findLastUserBubbleEl() {
    const sels = [".msg-user", ".message.user", ".bubble.user", ".chat-msg.user"];
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      if (els.length) return els[els.length - 1];
    }
    // fallback: last message container if you tag it
    return null;
  }

  function renderFilesOnUserBubble(files) {
    if (!files?.length) return;
    const host = findLastUserBubbleEl();
    if (!host) return;

    const bubble = host.querySelector(".bubble");
    let row = host.querySelector(".msg-attachments");
    if (!row) {
      row = document.createElement("div");
      row.className = "msg-attachments";
      if (bubble) {
        // place ABOVE the bubble but inside the same bubble-wrap
        bubble.insertAdjacentElement("beforebegin", row);
      } else {
        // fallback: first child
        host.insertBefore(row, host.firstChild);
      }
    } else {
      row.innerHTML = "";
    }

    files.forEach(f => {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      chip.innerHTML = `
        <span class="ac-ico-wrap"><span class="ac-icon">${iconForFile(f.name, f.type)}</span></span>
        <span class="ac-name" title="${f.name}">${f.name}</span>
      `;
      row.appendChild(chip);
    });
  }


  function positionPlusMenu(anchorEl) {
    if (!plusMenu || !anchorEl) return;

    const r = anchorEl.getBoundingClientRect();
    const gap = 8; // spacing between + and menu

    // Measure menu (ensure it's visible to get dimensions)
    const wasHidden = plusMenu.hasAttribute("hidden");
    if (wasHidden) plusMenu.removeAttribute("hidden");
    const mW = plusMenu.offsetWidth || 240;
    const mH = plusMenu.offsetHeight || 120;
    if (wasHidden) plusMenu.setAttribute("hidden", "");

    // Prefer showing ABOVE the + button
    const canShowAbove = mH + gap <= r.top;
    let top;
    if (canShowAbove) {
      top = r.top - mH - gap + window.scrollY;      // above
    } else {
      top = r.bottom + gap + window.scrollY;        // fallback below
    }

    // Align left with +, then clamp into viewport
    let left = r.left + window.scrollX;
    const minLeft = window.scrollX + 8;
    const maxLeft = window.scrollX + window.innerWidth - mW - 8;
    if (left < minLeft) left = minLeft;
    if (left > maxLeft) left = maxLeft;

    plusMenu.style.top = `${top}px`;
    plusMenu.style.left = `${left}px`;
  }

  // ---- + menu wiring (run only once) ----
  if (!document.body.dataset.gaiaPlusWired) {
  document.body.dataset.gaiaPlusWired = "1";
    if (moreBtn) {
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (plusMenu.hasAttribute("hidden")) {
          // reveal then position (so offsetWidth is measurable)
          plusMenu.removeAttribute("hidden");
          positionPlusMenu(moreBtn);
        } else {
          plusMenu.setAttribute("hidden", "");
        }
      });
    }

    // Close when clicking outside or resizing/scolling
    document.addEventListener("click", (e) => {
      if (!plusMenu || plusMenu.hasAttribute("hidden")) return;
      const target = e.target;
      if (target === plusMenu || plusMenu.contains(target) || target === moreBtn) return;
      plusMenu.setAttribute("hidden", "");
    });
    window.addEventListener("resize", () => !plusMenu?.hasAttribute("hidden") && positionPlusMenu(moreBtn));
    window.addEventListener("scroll", () => !plusMenu?.hasAttribute("hidden") && positionPlusMenu(moreBtn));

    // Menu actions
    if (plusUploadBtn && fileInput) {
      plusUploadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        fileInput.click();           // open system file picker
        plusMenu.setAttribute("hidden", "");
      });
    }
    if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      if (plusMenu) plusMenu.setAttribute("hidden", "");
      tryAddFiles(e.target.files);
    });
    }
  }

  const composerInner = document.querySelector(".composer-inner"); // for height sync
  const themeToggleBtn = $("#theme-toggle");
  const themeIcon = $("#theme-icon");
  window.GAIA = window.GAIA || {};
  GAIA.settings = GAIA.settings || {};
  GAIA.settings.streaming = 'sse'; // 'sse' | 'off'
  // === Feature 2 (Regenerate/Stop) globals ===
  let GAIA_ABORT = null;
  window.GAIA_V5 = window.GAIA_V5 || {}; // will hold lastUserIndex
  GAIA_V5.attachForNext = GAIA_V5.attachForNext || []; // files selected for the next user message


  const THEME_KEY = "gaia_theme"; // "light" | "dark"

  function systemPrefersDark(){
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme(theme){ // "light" | "dark"
    const root = document.documentElement;
    if (theme === "dark") {
      root.setAttribute("data-theme", "dark");
      if (themeIcon) themeIcon.textContent = "☀️"; // show sun when currently dark (click => light)
    } else {
      root.setAttribute("data-theme", "light");
      if (themeIcon) themeIcon.textContent = "🌙"; // show moon when currently light (click => dark)
    }
  }

  function getInitialTheme(){
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return systemPrefersDark() ? "dark" : "light";
  }

  function toggleTheme(){
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }
  // -------- keep messages padding equal to composer height --------
  const setComposerHeight = () => {
    if (!composerInner) return;
    const h = composerInner.offsetHeight || 72;
    document.documentElement.style.setProperty("--composer-h", `${h}px`);
  };
  window.addEventListener("resize", setComposerHeight);
  window.addEventListener("resize", positionChipsToInput);
  window.addEventListener("scroll", positionChipsToInput);

  // When the textarea grows/shrinks, keep chips aligned
  inputEl?.addEventListener("input", () => {
    positionChipsToInput();
  });
  if (window.ResizeObserver && composerInner) {
    try { new ResizeObserver(setComposerHeight).observe(composerInner); } catch(_) {}
  }

  // -------- local storage for chats --------
  const LS_KEY = "gaia_chats_v2";
  let currentId = null;

  const DEFAULT_STATS = () => ({ in_tokens: 0, out_tokens: 0, total_tokens: 0 });

  const loadAll = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; } };
  const saveAll = (x) => localStorage.setItem(LS_KEY, JSON.stringify(x));
  const createChat = (name="New chat") => {
  const chat = { id: "c_" + Date.now(), name, model: modelSel?.value || "grok", history: [], stats: DEFAULT_STATS() };
  const all = loadAll(); all.unshift(chat); saveAll(all); return chat;
  }; 
  const getChat = id => {
  const ch = loadAll().find(c => c.id === id);
  if (ch && !ch.stats) { ch.stats = DEFAULT_STATS(); updateChat(ch); }
  return ch;
  };
  const updateChat = ch => { const all = loadAll(); const i = all.findIndex(x => x.id === ch.id); if (i>=0){ all[i] = ch; saveAll(all); } };
  const deleteChat = id => { saveAll(loadAll().filter(c => c.id !== id)); };

  // -------- formatting (denser, safe HTML) --------
  const escapeHTML = (s) =>
    String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  let formatText = (text) => {
    const raw = String(text || "");
  
    // Split on ```fences``` to isolate code blocks.
    // Odd indices are code blocks, even are normal text.
    const parts = raw.split(/```/);
    let html = "";
  
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // Code block: optional "lang\n" header
        const block = parts[i];
        const nl = block.indexOf("\n");
        let lang = "", code = block;
        if (nl >= 0) { lang = block.slice(0, nl).trim(); code = block.slice(nl + 1); }
        const safeCode = escapeHTML(code);
        const langAttr = lang ? ` data-lang="${escapeHTML(lang)}"` : "";
        html += `<pre><code${langAttr}>${safeCode}</code><button class="copy-code-btn" title="Copy code">Copy</button></pre>`;
      } else {
        // Normal text: paragraphs + <br> (keep your original behavior)
        const safe = escapeHTML(parts[i]);
        html += safe
          .split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
      }
    }
    return html;
  };
  // --- GAIA V7 Markdown+ integration (lazy wrapper; no race with script order) ---
  (() => {
    const _origFormatText = formatText;
    formatText = (text) => {
      const t = text || "";
      if (window.GAIA && typeof GAIA.mdPlus === "function") {
        try { return GAIA.mdPlus(t); } 
        catch (e) { console.warn("Markdown+ failed, fallback to original::", e); }
      }
      return _origFormatText(t);
    };
  })();
  const makeIconBtn = (label, action) => {
    const b = document.createElement("button");
    b.className = "icon";
    b.setAttribute("type", "button");
    b.setAttribute("data-action", action);
    b.textContent = label;
    return b;
  };
  
  const makeActions = ({ role, deleted, editing }) => {
    const box = document.createElement("div");
    box.className = "bubble-actions";
  
    if (editing) {
      box.appendChild(makeIconBtn("✓", "save"));
      box.appendChild(makeIconBtn("✕", "cancel"));
      return box;
    }
    box.appendChild(makeIconBtn("📋", "copy"));
    if (role === "user") box.appendChild(makeIconBtn("✎", "edit"));
    if (role === "assistant") box.appendChild(makeIconBtn("↻", "regenerate"));  // <<< add this
    box.appendChild(makeIconBtn(deleted ? "↩" : "🗑", deleted ? "restore" : "delete"));
    return box;
  };
  
  
  const flash = (el, ok = true, restore = null) => {
    const prev = el.textContent;
    el.textContent = ok ? "✓" : "!";
    setTimeout(() => { el.textContent = restore ?? prev; }, 700);
  };
  
  async function sendEditedAtIndex(userIdx){
    const chat = getChat(currentId);
    if (!chat) return;
  
    const userMsg = chat.history[userIdx];
    // Anchor = the original message index (if this is a branched msg, it's in branch_of)
    const anchor  = (typeof userMsg.branch_of === "number") ? userMsg.branch_of : (userIdx - 1);
    // Version = this user's branch version, or current active version (fallback to 2)
    const version = userMsg.branch_version || (chat.branch?.active ?? 2);
  
    // Provider should see ONLY history before the anchor (like ChatGPT edit behavior)
    const historyForProvider = chat.history.slice(0, anchor);
  
    setBusy(true);
    addTyping();
    setComposerHeight();
    // === Feature 2: Stop support for edited-send ===
    if (GAIA_ABORT) { try { GAIA_ABORT.abort(); } catch(_){} }
    GAIA_ABORT = new AbortController();
  
    try {
      const res = await gaiaFetch("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelSel?.value || "grok",
          model_version: versionSel?.value || "",
          message: userMsg?.content || "",
          history: historyForProvider.map(m => ({ role: m.role, content: m.content })),
          chatId: currentId
        }),
        signal: GAIA_ABORT.signal 
      });
  
      const data = await res.json();
      removeTyping();
  
      const reply = (data && data.reply) ? String(data.reply).trim() : "Error: empty response";
      const meta  = { model: data.model, usage: data.usage };
  
      // Insert assistant right after the edited user message, tagged with the same anchor/version
      const assistantIdx  = userIdx + 1;
      const assistantTime = Date.now();
      chat.history.splice(assistantIdx, 0, {
        role: "assistant",
        content: reply,
        meta,
        time: assistantTime,
        branch_of: anchor,
        branch_version: version
      });
  
      // Update running totals
      if (meta && meta.usage) {
        chat.stats.in_tokens    = (chat.stats.in_tokens    || 0) + (meta.usage.prompt_tokens     || 0);
        chat.stats.out_tokens   = (chat.stats.out_tokens   || 0) + (meta.usage.completion_tokens || 0);
        chat.stats.total_tokens = (chat.stats.total_tokens || 0) + (meta.usage.total_tokens      || 0);
      }
      if (typeof Feature2RegenerateStop !== "undefined") {
        Feature2RegenerateStop.noteLastInteraction({ userIndex: userIdx, sql: data.sql || null });
      }
      updateChat(chat);
      renderChat(); // re-render so the correct version path shows
    } catch (e) {
      removeTyping();
      if (e && e.name === "AbortError") {
        addMessage("assistant", "(stopped)", null, { idx: userIdx + 1, time: Date.now() });
      } else {
        addMessage("assistant", "Error: " + e.message, null, { idx: userIdx + 1, time: Date.now() });
      }
    } finally {
      setBusy(false);
      setComposerHeight();
      GAIA_ABORT = null;
    }
  }
  
  

  // -------- rendering --------
  const addMessage = (role, text, meta = null, opts = {}) => {
    // opts: { idx, deleted, time, editing, edited, isAnchor, branchInfo }
    const wrap = document.createElement("div");
    wrap.className = `msg ${role === "user" ? "msg-user" : "msg-ai"}`;
    if (opts.deleted) wrap.classList.add("is-deleted");
    if (opts.editing) wrap.classList.add("is-editing");
    if (typeof opts.idx === "number") wrap.dataset.idx = String(opts.idx);
  
    const bw = document.createElement("div");
    bw.className = "bubble-wrap";
  
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (opts.editing && role === "user") {
      const ta = document.createElement("textarea");
      ta.className = "bubble-editor";
      ta.value = text || "";
      bubble.appendChild(ta);
      setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }, 0);
    } else {
      bubble.innerHTML = opts.deleted ? "<em>Message deleted</em>" : formatText(text);
    }
    bw.appendChild(bubble);
  
    const timeStr = new Date(opts.time || Date.now())
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  
    const metaEl = document.createElement("div");
    metaEl.className = "msg-meta";
    if (role === "assistant") {
      const parts = [];
      if (meta?.model) parts.push(String(meta.model).toLowerCase());
      if (meta?.usage && typeof meta.usage === "object") {
        const u = meta.usage;
        parts.push(`in ${u.prompt_tokens ?? "?"}  ·  out ${u.completion_tokens ?? "?"}  ·  total ${u.total_tokens ?? "?"}`);
      }
      parts.push(timeStr);
      metaEl.textContent = parts.join("  ·  ");
    } else {
      metaEl.textContent = timeStr + (opts.edited ? "  ·  " : "");
      if (opts.edited) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "edited";
        metaEl.appendChild(tag);
      }
    }
    // --- NEW: show a paper-clip if this user message had attachments ---
    if (role === "user") {
      const count = Number(opts.attachCount || 0);
      if (count > 0) {
        const clip = document.createElement("span");
        clip.className = "msg-clip";
        clip.title = `${count} attachment${count > 1 ? "s" : ""}`;
        clip.textContent = "📎";
        metaEl.appendChild(clip);
      }
    }
      
    const foot = document.createElement("div");
    foot.className = "bubble-foot";
    foot.appendChild(metaEl);
  
    // right side: pager (if anchor) + actions (hover reveal)
    const right = document.createElement("div");
    right.className = "right-tools";
  
    if (opts.isAnchor && opts.branchInfo && opts.branchInfo.total >= 2) {
      const vp = document.createElement("button");
      vp.className = "version-pager";
      vp.setAttribute("type", "button");
      vp.setAttribute("data-action", "toggle-version");
      vp.textContent = `${opts.branchInfo.active}/${opts.branchInfo.total}`;
      right.appendChild(vp);
    }
  
    right.appendChild(makeActions({ role, deleted: !!opts.deleted, editing: !!opts.editing }));
    foot.appendChild(right);
  
    bw.appendChild(foot);
    wrap.appendChild(bw);
  
    messagesEl.appendChild(wrap);
    scrollToEndSafe();
  };
  
  // Tracks whether user is already near bottom (so we don't yank scroll when user is reading older msgs)
  let _stickToBottom = true;

  function _isNearBottom(el, threshold = 140) {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
  }

  function scrollToEndSafe(force = false) {
    const messages = document.getElementById("messages");
    if (!messages) return;

    if (!force && !_stickToBottom) return;

    // Multi-tick scroll: handles markdown render + code highlighting + layout shifts
    requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight;

      requestAnimationFrame(() => {
        messages.scrollTop = messages.scrollHeight;
        setTimeout(() => {
          messages.scrollTop = messages.scrollHeight;
        }, 0);
      });
    });
  }

  // IMPORTANT: make it callable by stream_renderer.js and other modules
  window.scrollToEndSafe = scrollToEndSafe;

  // Update stickiness when user scrolls
  const _messagesEl = document.getElementById("messages");
  if (_messagesEl) {
    _messagesEl.addEventListener("scroll", () => {
      _stickToBottom = _isNearBottom(_messagesEl);
    }, { passive: true });
  }

  function pushUserMessage(chat, text){
    const idx = chat.history.length;
    const t = Date.now();
    chat.history.push({ role: "user", content: text, time: t });
    GAIA.Memory?.record(currentId, "user", text, { idx });
    updateChat(chat);
    addMessage("user", text, null, { idx, time: t });
    return idx;
  }

  function pushAiMessage(chat, text){
    const idx = chat.history.length;
    const t = Date.now();
    // placeholder in DOM
    addMessage("assistant", text || "", null, { idx, time: t });
    // persist a shell so sendSSE can fill it later
    chat.history.push({ role: "assistant", content: text || "", time: t });
    updateChat(chat);
    return idx;
  }

  function getBubbleEl(idx){
    return document.querySelector(`.msg.msg-ai[data-idx="${idx}"]`);
  }

    // === Feature 2 host helpers for regenerate-stop.js ===
  function getUserBubbleTextAt(index) {
    // Prefer live editor text if the user message is in edit mode
    const node = document.querySelector(`.msg-user[data-idx="${index}"] .bubble`);
    if (!node) return null;
    const editor = node.querySelector("textarea.bubble-editor");
    return editor ? editor.value : (node.innerText || "").trim();
  }

  async function loadModelVersions(force = false) {
    if (!versionSel) return;

    const reqId = ++_mvReqSeq;

    try {
      const res = await fetch(`/models/versions${force ? "?force=1" : ""}`, { cache: "no-store" });
      const json = await res.json();

      // If another request started after this one, ignore this response (prevents duplicates).
      if (reqId !== _mvReqSeq) return;

      const entry = (json && json.data && json.data[modelSel.value]) ? json.data[modelSel.value] : {};
      const versions = (entry.versions || []).slice(0, 3); // show only top 3

      // Reset only when we are sure we're writing the latest response.
      versionSel.innerHTML = '<option value="">latest</option>';

      for (const v of versions) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = (v.label || v.id);
        versionSel.appendChild(opt);
      }
    } catch (e) {
      // Safe fallback: keep "latest"
      versionSel.innerHTML = '<option value="">latest</option>';
    }
  }


  // ensure it refreshes when model changes
  modelSel.addEventListener("change", () => loadModelVersions(false));
  function getCurrentBranchTag(){ return (getChat(currentId)?.branch && "v" + getChat(currentId).branch.active) || "v1"; }

  // Render a temporary assistant bubble (placeholder). Returns its idx.
  function hostRenderAssistantBubble(text, opts = {}) {
    const chat = getChat(currentId) || createChat();
    const assistantIdx = chat.history.length;  // next slot
    const t = Date.now();
    addMessage("assistant", text, null, { idx: assistantIdx, time: t });
    return assistantIdx;
  }
  
  // ===== Vault Viewer State =====
  let __vaultActiveFile = null;

  function openVaultViewer(file) {
    __vaultActiveFile = file;

    const backdrop = document.getElementById("vaultViewerBackdrop");
    const nameEl   = document.getElementById("vaultViewerName");
    const metaEl   = document.getElementById("vaultViewerMeta");
    const preEl    = document.getElementById("vaultViewerContent");
    const fbEl     = document.getElementById("vaultViewerFallback");

    nameEl.textContent = file.name || "File";
    metaEl.textContent = file.sizeLabel ? `(${file.sizeLabel})` : "";
    preEl.textContent = "";
    fbEl.hidden = true;

    backdrop.classList.add("is-open");
    backdrop.setAttribute("aria-hidden", "false");

    // Fetch & show preview (text-like files)
    loadVaultPreview(file).catch(() => {
      fbEl.hidden = false;
    });
  }

  function closeVaultViewer() {
    const backdrop = document.getElementById("vaultViewerBackdrop");
    backdrop.classList.remove("is-open");
    backdrop.setAttribute("aria-hidden", "true");
    __vaultActiveFile = null;
  }

  async function loadVaultPreview(file) {
    const name = file?.name || file?.file?.name || "file";
    const ext = name.split(".").pop().toLowerCase();
    const textLike = ["txt","md","csv","json","js","py","html","css","log","xml","yaml","yml"].includes(ext);
    if (!textLike) throw new Error("Non-text");

    // Prefer in-memory blobs/files first
    if (file instanceof File) {
      document.getElementById("vaultViewerContent").textContent = await file.text();
      return;
    }
    if (file?.file instanceof File) {
      document.getElementById("vaultViewerContent").textContent = await file.file.text();
      return;
    }
    if (file?.data instanceof Blob) {
      document.getElementById("vaultViewerContent").textContent = await file.data.text();
      return;
    }

    // Fallback to URL fetch
    const url = file?.viewUrl || file?.downloadUrl;
    if (!url) throw new Error("No preview source");

    const res = await fetch(url);
    if (!res.ok) throw new Error("Fetch failed");
    document.getElementById("vaultViewerContent").textContent = await res.text();
  }

  function downloadVaultFile(file) {
    const name = file?.name || file?.file?.name || "download";
    let blob = null;

    if (file instanceof File) blob = file;
    else if (file?.file instanceof File) blob = file.file;
    else if (file?.data instanceof Blob) blob = file.data;

    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }

    const url = file?.downloadUrl || file?.viewUrl;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }


  function attachVaultFile(file) {
    // ✅ Tie into your existing "selected attachment" mechanism.
    // Replace this with your real function/variable.
    // Example: setActiveAttachment(file);
    // Convert vault record -> File (so it behaves like normal upload)
    let f = null;

    if (file instanceof File) f = file;
    else if (file?.file instanceof File) f = file.file;
    else if (file?.data instanceof Blob) {
      f = new File([file.data], file.name || "file", { type: file.type || "application/octet-stream" });
    }

    if (!f) return;
    tryAddFiles([f]); // ✅ uses your limits + calls updateChips()
  }

  window.VaultViewer = {
    open: openVaultViewer,
    close: closeVaultViewer,
    download: downloadVaultFile,
    attach: attachVaultFile
  };

  document.addEventListener("DOMContentLoaded", () => {
    const backdrop = document.getElementById("vaultViewerBackdrop");
    if (!backdrop) return;

    const btnClose = document.getElementById("vaultViewerClose");
    const btnDl    = document.getElementById("vaultViewerDownload");
    const btnAtt   = document.getElementById("vaultViewerAttach");

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeVaultViewer();
    });

    btnClose?.addEventListener("click", closeVaultViewer);

    btnDl?.addEventListener("click", () => {
      if (__vaultActiveFile) downloadVaultFile(__vaultActiveFile);
    });

    btnAtt?.addEventListener("click", () => {
      if (__vaultActiveFile) attachVaultFile(__vaultActiveFile);
      closeVaultViewer();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeVaultViewer();
    });
  });

  document.addEventListener("DOMContentLoaded", () => {
    const mq = window.matchMedia("(max-width: 900px)");

    const applyVaultRestore = () => {
      if (mq.matches) {
        document.body.classList.remove("vault-collapsed");
        return;
      }
      if (localStorage.getItem("vaultCollapsed") === "1") {
        document.body.classList.add("vault-collapsed");
      } else {
        document.body.classList.remove("vault-collapsed");
      }
    };

    applyVaultRestore();

    try { mq.addEventListener("change", applyVaultRestore); }
    catch { mq.addListener(applyVaultRestore); }
  });

// ==============================
// Vault mini rail (collapsed icons)
// ==============================
function ensureVaultMiniRail() {
  // Try common vault panel selectors (keep flexible)
  const panel =
    document.getElementById("vault-panel") ||
    document.querySelector(".vault-panel") ||
    document.querySelector("#attachment-vault") ||
    document.querySelector(".attachment-vault");

  if (!panel) return null;

  let rail = panel.querySelector(".vault-mini-rail");
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "vault-mini-rail";
    // Put it near the top so it behaves like a sidebar mini rail
    panel.prepend(rail);
  }
  return rail;
}

function getVaultItemName(item, idx) {
  return (
    item.getAttribute("data-name") ||
    item?.dataset?.name ||
    item.querySelector(".vault-name")?.textContent?.trim() ||
    item.querySelector(".file-name")?.textContent?.trim() ||
    `File ${idx + 1}`
  );
}

function syncVaultMiniRail() {
    const rail = ensureVaultMiniRail();
    if (!rail) return;

    const items = Array.from(document.querySelectorAll("#vault-list .vault-item"));
    rail.innerHTML = "";

    items.forEach((item, idx) => {
      const name = getVaultItemName(item, idx);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vault-mini-btn";
      btn.title = name;                 // <-- hover shows file name (browser tooltip)
      btn.setAttribute("aria-label", name);

      // Try to clone an existing icon from the row
      const icon =
        item.querySelector("img, svg, .vault-file-icon, .file-icon, .vault-icon");

      if (icon) {
        btn.appendChild(icon.cloneNode(true));
      } else {
        const fallback = document.createElement("span");
        fallback.className = "vault-mini-fallback";
        fallback.textContent = "📄";
        btn.appendChild(fallback);
      }

      // Click icon = behave like clicking the real vault row (opens viewer etc.)
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // MOBILE: toggle the drawer (same system as mobileDrawersV2)
        if (mq.matches) {
          const backdrop = document.getElementById("drawerBackdrop");

          // close right drawer if open
          document.body.classList.remove("mobile-right-open");

          const openNow = !document.body.classList.contains("mobile-left-open");
          document.body.classList.toggle("mobile-left-open", openNow);

          if (backdrop) backdrop.hidden = !openNow;
          return;
        }

        // DESKTOP: keep existing collapse behavior
        apply(!document.body.classList.contains('sidebar-collapsed'));
      });

      rail.appendChild(btn);
    });
  }

  // Init + keep in sync
  (function initVaultMiniRail() {
    const vaultListEl = document.getElementById("vault-list");
    if (vaultListEl) {
      new MutationObserver(() => syncVaultMiniRail()).observe(vaultListEl, {
        childList: true,
        subtree: true,
      });
    }

    // Also resync when body class changes (vault collapsed/open)
    new MutationObserver(() => syncVaultMiniRail()).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    syncVaultMiniRail();
  })();


  // Replace placeholder text, then persist to history and re-render
  function hostUpdateAssistantBubble(idx, text, opts = {}) {
    const bubble = document.querySelector(`.msg.msg-ai[data-idx="${idx}"] .bubble`);
    if (bubble) bubble.innerHTML = formatText(text);

    // Persist as a real assistant message (so it survives re-render)
    const chat = getChat(currentId) || createChat();
    const meta = (opts && opts.meta) ? opts.meta : null; // module will pass {model, usage} if available
    const t = Date.now();
    // if that idx already exists in history as assistant, skip; otherwise push
    if (!chat.history[idx] || chat.history[idx].role !== "assistant") {
      chat.history.push({ role: "assistant", content: text, meta, time: t });
    } else {
      chat.history[idx].content = text;
      chat.history[idx].meta = meta || chat.history[idx].meta;
      chat.history[idx].time = t;
    }

    // Update token stats if usage is present
    if (meta && meta.usage) {
      const u = meta.usage;
      chat.stats.in_tokens    = (chat.stats.in_tokens || 0) + (u.prompt_tokens || 0);
      chat.stats.out_tokens   = (chat.stats.out_tokens || 0) + (u.completion_tokens || 0);
      chat.stats.total_tokens = (chat.stats.total_tokens || 0) + (u.total_tokens || 0);
    }
    updateChat(chat);
    renderChat();
    GAIA.Memory?.record(currentId, "assistant", text, { idx });
  }

  
  const addTyping = () => {
    const old = document.getElementById("typing");
    if (old) old.remove();
    const w = document.createElement("div");
    w.className = "msg msg-ai"; 
    w.id = "typing";
    w.innerHTML = `<div class="bubble">Thinking…</div>
                  <div class="bubble-foot"><div class="msg-meta">
                    ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div></div>`;
    messagesEl.appendChild(w);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  const removeTyping = () => document.getElementById("typing")?.remove();


  const renderSidebar = () => {
    chatListEl.innerHTML = "";
    loadAll().forEach(c => {
      const item = document.createElement("div");
      item.className = "chat-item" + (c.id === currentId ? " active" : "");
      const nm = document.createElement("div"); nm.className = "chat-name"; nm.textContent = c.name || "Untitled";
      const act = document.createElement("div"); act.className = "item-actions";
      const rn = document.createElement("button"); rn.title = "Rename"; rn.textContent = "✎";
      rn.onclick = (e) => { e.stopPropagation(); const n = prompt("Rename chat:", c.name || "Untitled"); if (n !== null) { c.name = (n.trim() || "Untitled"); updateChat(c); if (c.id === currentId) document.title = c.name + " — GAIA"; renderSidebar(); } };
      const del = document.createElement("button"); del.title = "Delete"; del.textContent = "🗑";
      del.onclick = (e) => { e.stopPropagation(); if (confirm("Delete this chat?")) { deleteChat(c.id); if (c.id === currentId) { currentId = null; ensureCurrent(); } renderSidebar(); } };
      act.appendChild(rn); act.appendChild(del);
      item.appendChild(nm); item.appendChild(act);
      item.onclick = () => openChat(c.id);
      chatListEl.appendChild(item);
    });
  };

  const renderChat = () => {
    const chat = getChat(currentId);
    const br = chat?.branch && typeof chat.branch.anchor === "number" ? chat.branch : null;
  
    messagesEl.innerHTML = "";
    const hist = chat?.history || [];
    let skipIdx = -1;
  
    for (let i = 0; i < hist.length; i++) {
      const m = hist[i];
  
      if (br) {
        if (i < br.anchor) {
          addMessage(m.role, m.content, m.meta, {
            idx: i, deleted: !!m.deleted, time: m.time, editing: !!m.editing, edited: !!m.edited,
            attachCount: m.attachCount || 0
          });
          continue;
        }
  
        if (i === br.anchor) {
          if (br.active === 1) {
            addMessage(m.role, m.content, m.meta, {
              idx: i, deleted: !!m.deleted, time: m.time, editing: !!m.editing, edited: !!m.edited,
              isAnchor: true, branchInfo: br,
              attachCount: m.attachCount || 0
            });
          } else {
            const vUserIdx = hist.findIndex(
              (x, j) => j > i && x.branch_of === i && x.branch_version === br.active && x.role === "user"
            );
            if (vUserIdx !== -1) {
              const v2 = hist[vUserIdx];
              addMessage(v2.role, v2.content, v2.meta, {
                idx: vUserIdx, deleted: !!v2.deleted, time: v2.time, editing: !!v2.editing, edited: !!v2.edited,
                isAnchor: true, branchInfo: br,
                attachCount: m.attachCount || 0
              });
              skipIdx = vUserIdx;
            } else {
              addMessage(m.role, m.content, m.meta, {
                idx: i, deleted: !!m.deleted, time: m.time, editing: !!m.editing, edited: !!m.edited,
                isAnchor: true, branchInfo: br,
                attachCount: m.attachCount || 0
              });
            }
          }
          continue;
        }
  
        if (i > br.anchor) {
          if (br.active === 1) {
            if (m.branch_of === br.anchor) continue; // hide all branch items
          } else {
            if (i === skipIdx) continue; // already rendered user at anchor slot
            if (!(m.branch_of === br.anchor && m.branch_version === br.active)) continue; // show only active version
          }
        }
      }
  
      addMessage(m.role, m.content, m.meta, {
        idx: i, deleted: !!m.deleted, time: m.time, editing: !!m.editing, edited: !!m.edited,
        isAnchor: br && i === br.anchor, branchInfo: br && i === br.anchor ? br : null
      });
    }
  
    if (modelSel && chat) modelSel.value = chat.model || "grok";
    if (statusEl && chat?.stats) {
      const s = chat.stats;
      statusEl.textContent = `Model: ${chat.model}  —  in ${s.in_tokens} · out ${s.out_tokens} · total ${s.total_tokens}`;
    }
    document.title = (chat?.name || "Chat") + " — GAIA";
    setComposerHeight();
  };

  async function confirmDialog(title = "Are you sure?", body = "", okText = "OK", cancelText = "Cancel") {
    // If you already have a centered modal system, call it here and resolve true/false.
    // Fallback to native confirm so this works immediately:
    return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  }
  
  

  const ensureCurrent = () => {
    const all = loadAll();
    if (!currentId || !getChat(currentId)) currentId = all.length ? all[0].id : createChat().id;
    renderSidebar(); 
    renderChat();
  };
  const openChat = id => { 
      if (window.Spaces?.closeSpaceHome) window.Spaces.closeSpaceHome();   // ← leaves spaces
      currentId = id; 
      renderSidebar(); 
      renderChat(); 
      try { window.AttachVault?.renderForChat(currentId); } catch {}
  };

  // -------- send flow --------
  function setBusy(b) {
    GAIA_BUSY = !!b;
    if (sendBtn) sendBtn.disabled = b;

    // also lock input and + button
    const composerInput = document.querySelector('#input');
    const plusBtn = document.getElementById('more');
    if (composerInput) composerInput.disabled = b;
    if (plusBtn)       plusBtn.disabled = b;

    if (statusEl) statusEl.textContent = b ? "Working…" : "Ready";
  }
  const addSystem = (t) => addMessage("assistant", t);

  // Complete send() — handles attachments (FormData), shows files on user bubble with downloads,
  // keeps history/stats, and has a safe JSON response guard.
  // Turn vault records into File objects if the message mentions them
  async function filesReferencedInMessage(message) {
    try {
      if (!window.AttachVault || !currentId) return [];
      const rows = await AttachVault.listForChat(currentId); // [{ name, type, size, data(Blob), ... }]
      const msg = String(message || "").toLowerCase();
      const out = [];
      const seen = new Set();

      for (const r of rows || []) {
        if (!r || !r.name || !r.data) continue;
        const nm = String(r.name).toLowerCase();

        // Simple, robust match: filename substring (case-insensitive).
        // You can tighten this later with word-boundary regex if you like.
        if (msg.includes(nm)) {
          // De-dup by name+size (cheap + good-enough)
          const key = `${r.name}|${r.size || 0}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Convert vault Blob -> File so it behaves like a normal upload
          const f = new File([r.data], r.name, {
            type: r.type || "application/octet-stream",
            lastModified: r.savedAt || Date.now()
          });
          out.push(f);
        }
      }
      return out;
    } catch (e) {
      console.warn("vault reference scan failed:", e);
      return [];
    }
  }

  const send = async () => {
    if (GAIA_BUSY) return;

    const q = (inputEl?.value || "").trim();
    if (!q) return;

    // ➊ Grab files from chips (composer)
    const filesFromChips = Array.isArray(PENDING_FILES) ? [...PENDING_FILES] : [];

    // ➋ Also grab vault files that are mentioned in the message
    const filesFromVaultRefs = await filesReferencedInMessage(q);

    // ➌ Union + de-dup (by name+size)
    const uniq = new Map();
    [...filesFromChips, ...filesFromVaultRefs].forEach(f => {
      if (!f) return;
      const name = f.name || f.fileName || "file";
      const size = f.size || 0;
      uniq.set(`${name}|${size}`, f instanceof File ? f : (f.file || null));
    });
    const filesToSend = Array.from(uniq.values()).filter(Boolean);
    const filesPresent = filesToSend.length > 0;

    // Prefer SSE only if there are truly no files
    const ctx = GAIA.Memory?.contextForChat(currentId, 8, 4000) || { forApi: [] };
    const hasContext = !!(ctx.forApi && ctx.forApi.length);

    const chatForFallback = getChat(currentId) || createChat();
    const rawHist = chatForFallback.history || [];
    const fallback = rawHist.map(m => ({ role: m.role, content: m.content }));
    let histForApi = (ctx.forApi && ctx.forApi.length) ? ctx.forApi : fallback;

    // ELM: add a tiny quality-lift ONLY for cheap models + heavy context
    histForApi = (window.GAIA?.ELM?.maybeAugmentHistory?.(
      histForApi,
      { model: modelSel?.value || "grok", userText: q, filesPresent }
    )) || histForApi;

    const fileCtx = window.GAIA?.FileMem?.selectForQuery?.(currentId, q, 1200);
    if (Array.isArray(fileCtx) && fileCtx.length) {
      histForApi = [...histForApi, ...fileCtx];
    }
    // ---- TL;DR code pipeline gate (expensive model + code intent, no files)
    if (window.GAIA?.CodeFlow?.shouldPipeline?.(q, modelSel?.value || "grok", filesPresent)) {
      const chat = getChat(currentId) || createChat(); currentId = chat.id;

      // 1) USER bubble (so your input is always visible for all models)
      const userIdx = chat.history.push({
        role: "user",
        content: q,
        time: Date.now(),
        attachCount: 0
      }) - 1;
      updateChat(chat);
      addMessage("user", q, null, { idx: userIdx, time: chat.history[userIdx].time, attachCount: 0 });
      if (inputEl) { inputEl.value = ""; inputEl.style.height = "auto"; }
      setComposerHeight();

      // 2) Single AI placeholder
      const aiIdx = pushAiMessage(chat, "");
      addTyping(); setBusy(true);

      try {
        await GAIA.CodeFlow.runAndRender({
          question: q,
          model: modelSel?.value || "grok",
          history: histForApi,
          hooks: {
            renderAssistant: (text) =>
              hostUpdateAssistantBubble(aiIdx, text, { meta: { model: (modelSel?.value || "").toLowerCase() } }),
            renderError: (text) =>
              hostUpdateAssistantBubble(aiIdx, text, { meta: { model: (modelSel?.value || "").toLowerCase() } }),
          },
        });
        // Success — clear and STOP here (prevents second "Thinking...")
        removeTyping(); setBusy(false);
    try { const se = document.querySelector('#btn-stop'); if (se) se.disabled = true; } catch(_) {}
        return;
      } catch (err) {
        // CodeFlow failed — clean up and fall back to normal path ONCE
        try { GAIA.CodeFlow?.cancel?.(); } catch (_) {}
        removeTyping(); setBusy(false);
    try { const se = document.querySelector('#btn-stop'); if (se) se.disabled = true; } catch(_) {}

        // If placeholder is still empty, drop it before fallback
        const c = getChat(currentId);
        if (c && c.history[aiIdx] && !c.history[aiIdx].content) {
          c.history.splice(aiIdx, 1);
          updateChat(c);
          renderChat();
        }

        // Fallback to your normal path (SSE/JSON). Do not create another user bubble.
        if (GAIA.settings.streaming === 'sse' && !filesPresent) {
          await sendSSE(q);
        } else {
          await sendJSON(q);   // whatever your non-SSE branch is named
        }
        return;   // IMPORTANT: avoids a second AI placeholder
      }
    }


    const mk = (modelSel?.value || "grok");
    const sseAllowed = (mk === "grok" || mk === "gemini-pro");

    if (GAIA.settings.streaming === 'sse' && !filesPresent && sseAllowed) {
      if (inputEl){ inputEl.value = ""; inputEl.style.height = "auto"; }
      setComposerHeight();
      return sendSSE(q);
    }

    // JSON / attachments path → now we can lock the UI
    setBusy(true);

    // Ensure chat exists
    const chat = getChat(currentId) || createChat();
    currentId = chat.id;
    // SNAPSHOT history BEFORE adding q (avoid duplicating the last user turn)
    const ctxBefore = GAIA.Memory?.contextForChat(currentId, 8, 4000) || { forApi: [] };

    // Auto-name new chats
    if ((chat.name || "").toLowerCase() === "new chat" && chat.history.length === 0) {
      chat.name = q.slice(0, 40);
      updateChat(chat);
      renderSidebar();
    }

    // Push USER message into history
    chat.history.push({ role: "user", content: q });
    
    updateChat(chat);

    // Index & timestamp for this user message
    const userIdx = chat.history.length - 1;
    chat.history[userIdx].time = Date.now();
    updateChat(chat);
    // ⬅️ NEW: persist user message into GAIA.Memory
    GAIA.Memory?.record(currentId, "user", q, { idx: userIdx });
    // --- NEW: snapshot attachments for THIS user message & persist a count ---

    chat.history[userIdx].attachCount = filesToSend.length;
    updateChat(chat);

    // Render USER bubble
    // Render USER bubble (now shows 📎 when attachCount > 0)
    addMessage("user", q, null, {
      idx: userIdx,
      time: chat.history[userIdx].time,
      attachCount: filesToSend.length   // <-- NEW
    });
    window.GAIA_V5.lastUserIndex = userIdx;

    // Reset composer UI
    if (inputEl) {
      inputEl.value = "";
      inputEl.style.height = "auto";
    }
    setBusy(true);
    setComposerHeight();
    // Create a single AI placeholder bubble now; we will update it later.
    const aiIdx = pushAiMessage(chat, "");           // returns index
    const aiBubble = getBubbleEl(aiIdx);
    const aiTarget = aiBubble?.querySelector(".bubble") || aiBubble;
    // make the placeholder an “AI typing” bubble on the left
    aiBubble?.classList.add("typing");
    if (aiTarget) aiTarget.textContent = "Thinking…";

    const stopEl = document.querySelector("#btn-stop");
    if (stopEl) stopEl.disabled = false;

    if (GAIA_ABORT) {
      try { GAIA_ABORT.abort(); } catch (_) {}
    }

    // --- Snapshot attachments for THIS message (do not mutate while sending) ---
    //const filesToSend = Array.isArray(PENDING_FILES) && PENDING_FILES.length ? [...PENDING_FILES] : [];

    // Render attached files under this USER bubble (downloadable) and clear chips immediately
    if (filesToSend.length) {
      renderFilesOnUserBubble(filesToSend);  // uses File objects to make blob: URLs inside
      PENDING_FILES = [];
      if (fileInput) fileInput.value = "";
      if (typeof updateChips === "function") updateChips();
    }
    

    GAIA_ABORT = new AbortController();

    // Build request (FormData if files, JSON otherwise)
    const hasFiles = filesToSend.length > 0;
    let fetchOptions;

    if (hasFiles) {
      const fd = new FormData();
      fd.append("chatId", currentId);
      fd.append("model", modelSel?.value || "grok");
      fd.append("model_version", versionSel?.value || "");
      fd.append("message", q);
      fd.append("history", JSON.stringify(histForApi));
      // exclude the just-pushed user message from history sent to backend
      filesToSend.forEach((f, i) => {
        const fileObj = (f instanceof File) ? f : f?.file;
        if (fileObj) fd.append("files[]", fileObj, fileObj.name || `file_${i}`);
      });// KEY MUST BE 'files[]
      // V6: persist non-image files for this chat and render right panel
      // Persist attachments to the right Files panel for this chat
      try {
        if (window.AttachVault && filesToSend?.length) {
          const toStore = filesToSend.map(x => (x instanceof File ? x : x?.file)).filter(Boolean);
          await window.AttachVault.recordAndRender(currentId, toStore);
        }
      } catch (e) { console.warn("Vault error:", e); }

      // 🔽 NEW: index text-like files in background so they can be referenced later
      try {
        (async () => {
          for (const f0 of filesToSend) {
            const f = (f0 instanceof File) ? f0 : (f0?.file || null);
            if (!f) continue;

            const name = f.name || "file";
            const type = f.type || "";
            const isTextLike =
              /^text\//.test(type) || /json$|csv$/.test(type) ||
              /\.(txt|md|log|csv|tsv|json|py|js|ts|html|css|xml|yml|yaml)$/i.test(name);

            if (!isTextLike) continue;            // skip binaries (PDF needs a proper extractor)
            if (f.size > 1.5 * 1024 * 1024) continue; // cap ~1.5MB for cheap client indexing

            let text = "";
            try { text = await f.text(); } catch {}
            if (!text) continue;

            GAIA.FileMem?.indexFromUpload?.(
              currentId,
              { id: `local:${name}:${f.size}`, name, mime: type, size: f.size },
              text
            );
          }
        })();
      } catch (_) {}

      fd.append("style", "simple"); // V6: general chat style (no citations/tables). Use "structured" if you prefer bullets.'
      fetchOptions = { method: "POST", body: fd, signal: GAIA_ABORT.signal };
    } else {
      fetchOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelSel?.value || "grok",
          model_version: versionSel?.value || "",
          message: q,
          history: histForApi,
          chatId: currentId
        }),
        signal: GAIA_ABORT.signal
      };
    }

    // ---- Request/response ----
    try {
      const res = await gaiaFetch("/ask", fetchOptions);

      // Guard against HTML error pages (so res.json() doesn’t throw)
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const txt = await res.text();
        removeTyping();
        addMessage("assistant", `Error: server returned non-JSON.\n${txt.slice(0, 400)}`);
        return;
      }

      const data = await res.json();
      removeTyping();

      // (We already cleared chips right after queuing the message)
      // Nothing else to clear here, but keep this for symmetry if you switch strategy later.
      if (hasFiles) {
        PENDING_FILES = [];
        if (fileInput) fileInput.value = "";
        if (typeof updateChips === "function") updateChips();
      }

      const reply =
        (data && data.reply && String(data.reply).trim())
          ? String(data.reply).trim()
          : (data && data.ok === false && (data.error || data.message))
              ? `Error: ${data.error || data.message}`
              : "Error: empty response";
      const meta = { model: data.model, usage: data.usage };

      // Render ASSISTANT bubble
      // --- Update the existing placeholder (no second bubble) ---
      const assistantTime = Date.now();

      // 1) render into the placeholder bubble we created earlier
      if (aiTarget) {
        if (window.StreamRenderer) {
          // nice typewriter feel (optional)
          StreamRenderer.render(aiTarget, reply, { chunk: 'word', cps: 90 });
        } else {
          // final Markdown render
          aiTarget.innerHTML = (window.GAIA?.mdPlus ? GAIA.mdPlus(reply) : reply);
        }
      }

      // 2) persist into the SAME slot (aiIdx), not a new push
      chat.history[aiIdx].content = reply;
      chat.history[aiIdx].meta    = meta;
      chat.history[aiIdx].time    = assistantTime;
      GAIA.Memory?.record(currentId, "assistant", reply, { idx: aiIdx });
      updateChat(chat);

      // --- update the bubble footer with the actual model right now ---
      const metaEl = getBubbleEl(aiIdx)?.querySelector(".bubble-foot .msg-meta");
      if (metaEl) {
        const timeStr = new Date(assistantTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const parts = [];
        if (meta && meta.model) parts.push(String(meta.model).toLowerCase());
        parts.push(timeStr);
        metaEl.textContent = parts.join("  ·  ");
      }
      // --- NEW: update the bubble footer with the actual model right now ---
      try {
        const metaEl = getBubbleEl(aiIdx)?.querySelector(".bubble-foot .msg-meta");
        if (metaEl) {
          const timeStr = new Date(assistantTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const parts = [];
          if (meta && meta.model) parts.push(String(meta.model).toLowerCase());
          parts.push(timeStr);
          metaEl.textContent = parts.join("  ·  ");
        }
      } catch (_) {}
      // --------------------------------------------------------------------

      // 3) (optional) token stats accumulation
      if (meta && meta.usage) {
        chat.stats.in_tokens    = (chat.stats.in_tokens || 0) + (meta.usage.prompt_tokens || 0);
        chat.stats.out_tokens   = (chat.stats.out_tokens || 0) + (meta.usage.completion_tokens || 0);
        chat.stats.total_tokens = (chat.stats.total_tokens || 0) + (meta.usage.total_tokens || 0);
      }

      // Regenerate/Stop integration
      if (typeof Feature2RegenerateStop !== "undefined") {
        Feature2RegenerateStop.noteLastInteraction({ userIndex: userIdx, sql: data.sql || null });
      }

      // Refresh status bar
      if (statusEl) {
        const s = chat.stats || DEFAULT_STATS();
        const m = data.model ? `Model: ${data.model}  —  ` : "";
        statusEl.textContent = `${m}in ${s.in_tokens} · out ${s.out_tokens} · total ${s.total_tokens}`;
      }
    } catch (e) {
      removeTyping();
      const errText = (e && e.name === "AbortError")
        ? "(stopped)"
        : "Error: " + (e?.message || String(e));

      if (aiTarget) aiTarget.textContent = errText;
      // persist into the same slot
      chat.history[aiIdx].content = errText;
      chat.history[aiIdx].time    = Date.now();
      updateChat(chat);
    } finally {
      setBusy(false);
      setComposerHeight();
      if (stopEl) stopEl.disabled = true;
      GAIA_ABORT = null;
    }
  };

async function sendSSE(q) {
  if (GAIA_BUSY) return;
  const chat = getChat(currentId) || createChat(); currentId = chat.id;

  // Build history snapshot BEFORE pushing the new user turn.
  // Prefer GAIA.Memory; if unavailable, fall back to the stored chat history.
  let histForApi = [];
  try {
    const ctx = GAIA.Memory?.contextForChat(currentId, 8, 4000);
    if (ctx && Array.isArray(ctx.forApi) && ctx.forApi.length) histForApi = ctx.forApi;
  } catch(_) {}

  histForApi = (window.GAIA?.ELM?.maybeAugmentHistory?.(
    histForApi,
    { model: modelSel?.value || "grok", userText: q, filesPresent: false }
  )) || histForApi;

  const fileCtx = window.GAIA?.FileMem?.selectForQuery?.(currentId, q, 1200);
  if (Array.isArray(fileCtx) && fileCtx.length) {
    histForApi = [...histForApi, ...fileCtx];
  }
  // Inject Space SOP for SSE
  try {
    const spId = window.Spaces?.spaceOf?.(currentId);
    const setting = spId ? (window.Spaces?.getSpace?.(spId)?.setting || "") : "";
    if (setting) histForApi = [{ role: "system", content: String(setting) }, ...histForApi];
  } catch (_) {}
  if (!histForApi.length) {
    const raw = (chat.history || []).map(m => ({ role: m.role, content: m.content }));
    histForApi = raw.slice(-16); // fallback ~8 exchanges
  }
  // Reuse your existing path to push/render the user message:
  const userIdx = pushUserMessage(chat, q); // your helper that pushes + renders
  setBusy(true); // inline typing only
  const stopEl = document.querySelector("#btn-stop");
  if (stopEl) stopEl.disabled = false;
  // Create empty AI bubble placeholder to fill as text arrives:
  const aiIdx = pushAiMessage(chat, ""); // returns index
  const aiBubble = getBubbleEl(aiIdx);
  const textTarget = aiBubble?.querySelector(".bubble") || aiBubble;
  if (textTarget) {
    textTarget.textContent = "Thinking…";
  }
  aiBubble?.classList.add("typing");

  const modelKey = (modelSel?.value || "grok");
  const mv = (versionSel?.value || "");
  const url =
    `/ask/stream?model=${encodeURIComponent(modelKey)}`
    + `&model_version=${encodeURIComponent(mv)}`
    + `&q=${encodeURIComponent(q)}`
    + `&history=${encodeURIComponent(JSON.stringify(histForApi))}`;

  const es = new EventSource(url);
  currentSSE = es;

  let closed = false;
  let fullText = "";

  const finish = (ok = true) => {
    if (closed) return;
    closed = true;
    try { es.close(); } catch (e) {}
    currentSSE = null;
    removeTyping(); setBusy(false);
    try { const se = document.querySelector('#btn-stop'); if (se) se.disabled = true; } catch(_) {}

    // Persist final text into chat history
    // Persist final text into chat history
    const c = getChat(currentId);
    if (c && c.history[aiIdx]) {
      const renderedErr = (textTarget && textTarget.textContent) ? textTarget.textContent.trim() : "";
      const finalPersist =
        fullText.trim() ||
        (!ok ? (renderedErr || "⚠️ Stream error. Try again.") : "");

      c.history[aiIdx].content = finalPersist;
      c.history[aiIdx].time = Date.now();
      updateChat(c);
    }

    // ⬅️ NEW: persist streamed assistant reply once, after history is updated
    GAIA.Memory?.record(currentId, "assistant", fullText, { idx: aiIdx, stream: true });

    // Regenerate integration (SSE path)
    if (typeof Feature2RegenerateStop !== "undefined") {
      try { Feature2RegenerateStop.noteLastInteraction({ userIndex: userIdx, sql: null }); } catch(_) {}
    }
    // Final pretty Markdown render
    if (textTarget) {
      if (!fullText.trim() && ok === false) {
        // keep whatever error text we already set
      } else {
        textTarget.innerHTML = (GAIA.mdPlus ? GAIA.mdPlus(fullText) : fullText);
      }
    }
    scrollToEndSafe();
    const stopEl = document.querySelector("#btn-stop");
    if (stopEl) stopEl.disabled = true;
  };

  es.addEventListener("gaia_error", (e) => {
    try {
      const info = JSON.parse(e.data || "{}");
      const msg = info.error || "Stream error. Try again.";
      if (textTarget) textTarget.textContent = "⚠️ " + msg;
    } catch {
      if (textTarget) textTarget.textContent = "⚠️ Stream error. Try again.";
    }
    finish(false);
  });

  es.addEventListener("start", (e) => {
    try {
      const info = JSON.parse(e.data || "{}");
      const modelName = info.model || "";
      // persist meta onto this assistant turn
      const c = getChat(currentId);
      if (c && c.history[aiIdx]) {
        c.history[aiIdx].meta = { ...(c.history[aiIdx].meta || {}), model: modelName };
        updateChat(c);
      }
      // update the bubble footer in-place so user sees it immediately
      const metaEl = getBubbleEl(aiIdx)?.querySelector(".bubble-foot .msg-meta");
      if (metaEl) {
        const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const parts = [];
        if (modelName) parts.push(String(modelName).toLowerCase());
        parts.push(timeStr);
        metaEl.textContent = parts.join("  ·  ");
      }
    } catch (_) {}
  });

  es.addEventListener("delta", (e) => {
    try {
      const { text } = JSON.parse(e.data || "{}");
      if (!text) return;
      fullText += text;
      // Progressive plain text (fast)
      if (textTarget) textTarget.textContent = fullText;
      scrollToEndSafe();
    } catch {}
  });

  es.addEventListener("error", () => {
    if (textTarget && !fullText) textTarget.textContent = "⚠️ Stream error. Try again.";
    finish(false);
  });

  es.addEventListener("done", () => finish(true));
}



// -------- bubble actions (event delegation) --------
messagesEl?.addEventListener("click", (e) => {
  const pager = e.target?.closest?.(".version-pager");
  if (pager) {
    const chat = getChat(currentId);
    const br = chat?.branch; if (!br) return;
    br.active = (br.active % br.total) + 1;   // 1 → 2 → … → N → 1
    updateChat(chat);
    renderChat();
    return;
  }
  const codeCopy = e.target?.classList?.contains("copy-code-btn") ? e.target : null;
  const actBtn = codeCopy ? null : e.target?.closest?.("[data-action]");
  const msgEl = e.target?.closest?.(".msg");
  if (!msgEl) return;

  const idx = parseInt(msgEl.dataset.idx || "-1", 10);
  const chat = getChat(currentId);
  if (!chat || isNaN(idx) || idx < 0) return;
  const item = chat.history[idx];

  // Copy code (per block)
  if (codeCopy) {
    const codeEl = codeCopy.previousElementSibling;
    if (codeEl && codeEl.tagName === "CODE") {
      navigator.clipboard.writeText(codeEl.textContent || "");
      flash(codeCopy, true, "Copy");
    }
    return;
  }

  // Actions from the bubble menu
  const action = actBtn?.getAttribute?.("data-action");
  if (!action) return;

  if (action === "copy") {
    const allText = msgEl.querySelector(".bubble")?.innerText || "";
    navigator.clipboard.writeText(allText);
    flash(actBtn, true, "📋");
  } else if (action === "delete") {
    item.deleted = true;
    updateChat(chat);
    renderChat();
  } else if (action === "restore") {
    item.deleted = false;
    updateChat(chat);
    renderChat();
  } else if (action === "regenerate" && item?.role === "assistant") {
    // Find the closest preceding USER message index to use as the anchor
    let anchorIndex = -1;
    for (let j = idx - 1; j >= 0; j--) {
      const prev = chat.history[j];
      if (prev && prev.role === "user") { anchorIndex = j; break; }
    }
    if (anchorIndex < 0) return;
  
    // Kick off regenerate via the separate module
    if (typeof Feature2RegenerateStop !== "undefined") {
      Feature2RegenerateStop.regenerateFromAnchor(anchorIndex);
    }
    return;
  } else if (action === "edit" && item?.role === "user") {
    item.editing = true;
    updateChat(chat);
    renderChat();
  
  // SAVE: commit, insert a NEW user message below, and fetch a fresh reply from that point
  } else if (action === "save" && item?.role === "user" && item?.editing) {
    const ta = msgEl.querySelector(".bubble-editor");
    const newText = ta ? ta.value : (item.content || "");

  // anchor = the original message index (if editing a version, use its anchor)
  const anchor = (typeof item.branch_of === "number") ? item.branch_of : idx;

  // close edit
  item.editing = false;

  // init or bump branch state
  if (!chat.branch || chat.branch.anchor !== anchor) {
    chat.branch = { anchor, active: 2, total: 2 };
    } else {
      chat.branch.total = (chat.branch.total || 1) + 1;
      chat.branch.active = chat.branch.total;       // switch to newest version
    }
  const version = chat.branch.active;             // 2..N

  // insert new user version just after the last item of this branch cluster
  let insertIdx = anchor + 1;
  for (let j = anchor + 1; j < chat.history.length; j++) {
    const t = chat.history[j];
    if (t.branch_of === anchor) insertIdx = j + 1;
    else if (typeof t.branch_of !== "number") break;
    }

  const newUser = {
    role: "user",
    content: newText,
    time: Date.now(),
    edited_from: anchor,
    edited: true,
    branch_of: anchor,  
    branch_version: version
  };
  chat.history.splice(insertIdx, 0, newUser);

  updateChat(chat);
  renderChat();
// remember the new user version index for regenerate
  window.GAIA_V5.lastUserIndex = insertIdx;
  // fetch fresh assistant for this new version
  sendEditedAtIndex(insertIdx);

  
  // CANCEL: discard edit, keep original as-is
  } else if (action === "cancel" && item?.role === "user" && item?.editing) {
    item.editing = false;
    updateChat(chat);
    renderChat();
  }
});

  // -------- events --------
  sendBtn?.addEventListener("click", send);
  inputEl?.addEventListener("keydown", (e) => {
    if (GAIA_BUSY) { e.preventDefault(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl?.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    setComposerHeight(); // update messages padding when input grows
  });

  newChatBtn?.addEventListener("click", async () => {
    const n = prompt("Name your chat", "New chat");
    if (n === null) return;
    const ch = createChat((n.trim() || "New chat"));
    currentId = ch.id;
    try {
      // read space=... from URL and attach this chat if Spaces provides a helper
      const sp = new URLSearchParams(location.search).get("space");
      if (sp && window.Spaces?.attachChatToSpace) {
        await window.Spaces.attachChatToSpace(ch.id, sp);
      }
    } catch(_) {}
    renderSidebar();
    renderChat();
    try { window.AttachVault?.renderForChat(currentId); } catch {}
  });
  clearAllBtn?.addEventListener("click", () => {
    if (confirm("Clear all chats?")) { localStorage.removeItem(LS_KEY); currentId = null; ensureCurrent(); }
  });
  modelSel?.addEventListener("change", () => {
    const c = getChat(currentId); if (!c) return; c.model = modelSel.value; updateChat(c);
  });

  // === Feature 2: ESC to Stop current generation ===
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && GAIA_ABORT) {
      window.StreamRenderer?.stop();
      try { GAIA_ABORT.abort(); } catch(_) {}
      scrollToEndSafe();
    }
  });

  // === Feature 2: inject Stop + Regenerate inside composer (next to the Send button) ===
  document.addEventListener('DOMContentLoaded', () => {
    const inner = document.querySelector('.composer-inner');
    if (!inner) return;

    const sendBtn = inner.querySelector('#send');      // <-- correct ID
    if (!sendBtn) return;

    // One flex cell at the far-right of the grid
    let ctrls = inner.querySelector('.composer-ctrls');
    if (!ctrls) {
      ctrls = document.createElement('div');
      ctrls.className = 'composer-ctrls';
      // Move the existing Send button inside this group
      sendBtn.replaceWith(ctrls);
      ctrls.appendChild(sendBtn);
    }

    // Avoid duplicates on hot-reload
    if (!inner.querySelector('#btn-regenerate')) {
      const regen = document.createElement('button');
      regen.id = 'btn-regenerate';
      regen.className = 'btn compact';
      regen.type = 'button';
      regen.title = 'Regenerate';
      regen.textContent = '↻';
      regen.disabled = true;

      const stop = document.createElement('button');
      stop.id = 'btn-stop';
      stop.className = 'btn ghost compact';
      stop.type = 'button';
      stop.title = 'Stop';
      stop.textContent = '⏹';
      stop.disabled = true;

      // Order: Regenerate | Stop | Send
      ctrls.insertBefore(regen, sendBtn);
      ctrls.insertBefore(stop, sendBtn);

      // Bind to the module
      if (typeof Feature2RegenerateStop !== 'undefined') {
        Feature2RegenerateStop.bindToolbar({ stop: '#btn-stop', regen: '#btn-regenerate' });
      }
    }
  });

  // Stop button should also cancel host-side fetches
  document.addEventListener('click', (e) => {
    const stopBtn = e.target.closest('#btn-stop');
    if (!stopBtn) return;
    if (currentSSE) {
      try { currentSSE.close(); } catch (e) {}
      currentSSE = null;
    }
    if (GAIA_ABORT) { 
      window.StreamRenderer?.stop();
      try { GAIA_ABORT.abort(); } catch (_) {} 
      scrollToEndSafe();
    }
  });




  // ---- theme boot ----
  applyTheme(getInitialTheme());
  themeToggleBtn?.addEventListener("click", toggleTheme);

  // (optional) live-update icon when OS theme changes and no explicit choice saved
  if (window.matchMedia){
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", () => {
      const saved = localStorage.getItem(THEME_KEY);
      if (!saved) applyTheme(getInitialTheme());
    });
  }
  // === Feature 2 init (module loaded after app.js) ===
  if (typeof Feature2RegenerateStop !== "undefined") {
    Feature2RegenerateStop.registerHostApi({
      renderAssistantBubble: hostRenderAssistantBubble,
      updateAssistantBubble: hostUpdateAssistantBubble,
      renderAssistantNote: (t) => addMessage("assistant", t, null, { idx: (getChat(currentId)?.history.length || 0), time: Date.now() }),
      renderAssistantError: (t) => addMessage("assistant", t, null, { idx: (getChat(currentId)?.history.length || 0), time: Date.now() }),
      showTyping: addTyping,
      hideTyping: removeTyping,
      getUserBubbleTextAt,
      getCurrentBranchTag,
    });
    Feature2RegenerateStop.enablePerBubbleRegenerate();
  }

  // ---- RENDER GATE ----
  window.GAIA = window.GAIA || {};
  GAIA.renderBusy = false;           // true while a reply is in-flight
  GAIA.safeRender = function () {
    if (GAIA.renderBusy) return;     // skip if busy
    try { typeof renderChat === 'function' && renderChat(); } catch {}
  };

  // simple promise-based prompt using the GAIA modal
  const $modal = document.getElementById('gaia-modal');
  const $title = document.getElementById('gaia-modal-title');
  const $body  = document.getElementById('gaia-modal-body');
  const $ok    = document.getElementById('gaia-modal-ok');

  function openModal()  { $modal.classList.add('is-open'); document.body.classList.add('modal-open'); }
  function closeModal() { $modal.classList.remove('is-open'); document.body.classList.remove('modal-open'); }
  if ($modal && $title && $body && $ok) {
    $modal.addEventListener('click', (e) => {
      if (e.target === $modal || e.target.matches('[data-close]')) closeModal();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    async function gaiaPrompt({ title, label, value = '' }) {
      return new Promise((resolve) => {
        $title.textContent = title || ' ';
        $body.innerHTML = `
          <label style="display:block; margin:8px 0;">
            <div style="font-weight:600; margin-bottom:6px;">${label || ''}</div>
            <input id="gaia-modal-input" class="input" type="text" value="${value.replace(/"/g,'&quot;')}" autofocus>
          </label>
        `;
        const $input = () => document.getElementById('gaia-modal-input');

        const onOk = () => { const v = $input().value.trim(); cleanup(); closeModal(); resolve(v); };
        const onCancel = () => { cleanup(); closeModal(); resolve(null); };

        function cleanup() {
          $ok.removeEventListener('click', onOk);
          $modal.removeEventListener('close-cancel', onCancel);
        }

        $ok.textContent = 'OK';
        $ok.onclick = onOk;
        // wire cancel buttons
        $modal.querySelectorAll('[data-close]').forEach(btn => btn.onclick = onCancel);

        openModal();
        setTimeout(() => $input()?.focus(), 0);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const host = document.getElementById("messages");
    if (!host || !window.MutationObserver) return;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes || []) {
          if (n.nodeType === 1 && (n.matches?.(".msg.msg-ai") || n.querySelector?.(".msg.msg-ai"))) {
            scrollToEndSafe();
            return;
          }
        }
      }
    });
    mo.observe(host, { childList: true });
  });
  // -------- boot --------
  // When Markdown+ becomes ready later, just re-render current chat once.
  document.addEventListener('gaia:mdplus-ready', () => {
    const busy =
      !!(typeof GAIA_ABORT !== "undefined" && GAIA_ABORT) ||
      !!document.getElementById("typing") ||
      !!(document.querySelector('#send')?.disabled);
    if (busy) return;                   // ← skip if first reply is in-flight
    try { typeof renderChat === 'function' && renderChat(); } catch {}
  });

  GAIA.Memory?.init();
  loadModelVersions();
  ensureCurrent();
  try { window.AttachVault?.renderForChat(currentId); } catch {}
  if ((getChat(currentId)?.history || []).length === 0) {
    addSystem("Welcome! Pick a model or use the + button. Only **grok** replies right now.");
  }
  setComposerHeight();
})();

// === GAIA mobile: open/close left nav + file vault ===
document.addEventListener('DOMContentLoaded', () => {
  const leftBtn   = document.getElementById('mobile-open-left');
  const rightBtn  = document.getElementById('mobile-open-right');
  const sidebar   = document.querySelector('.sidebar');
  const vault     = document.getElementById('attachment-vault'); // created by attachment_vault.js
  const overlay   = document.getElementById('mobile-overlay');

  // If some elements are missing (e.g. on a non-chat page), just skip
  if (!leftBtn || !rightBtn || !sidebar || !overlay) return;

  const closeAll = () => {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('is-visible');
    if (vault) {
      vault.classList.remove('is-open');   // matches existing CSS for vault
    }
  };

  leftBtn.addEventListener('click', () => {
    const isOpen = sidebar.classList.contains('mobile-open');
    closeAll();
    if (!isOpen) {
      sidebar.classList.add('mobile-open');
      overlay.classList.add('is-visible');
    }
  });

  rightBtn.addEventListener('click', () => {
    if (!vault) return;                    // no vault mounted yet
    const isOpen = vault.classList.contains('is-open');
    closeAll();
    if (!isOpen) {
      vault.classList.add('is-open');      // slide-in vault (CSS already handles this)
      overlay.classList.add('is-visible');
    }
  });

  overlay.addEventListener('click', closeAll);
});

// === Desktop: ChatGPT-style collapse/expand LEFT sidebar (DISABLED on mobile) ===
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('toggle-left-nav');
  if (!btn) return;

  const KEY = 'leftNavCollapsed';
  const OLD_KEY = 'leftCollapsed'; // legacy key
  const mq = window.matchMedia('(max-width: 900px)');

  const readSaved = () => (localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY)) === '1';

  const apply = (collapsed) => {
    // MOBILE: never apply desktop mini/peek rail state
    if (mq.matches) {
      document.body.classList.remove('left-collapsed', 'sidebar-collapsed', 'left-mini');
      btn.textContent = '⮜';
      btn.setAttribute('aria-label', 'Collapse sidebar');
      btn.title = 'Collapse sidebar';
      return; // IMPORTANT: do not overwrite saved desktop preference
    }

    document.body.classList.remove('left-collapsed'); // kill legacy class
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    document.body.classList.toggle('left-mini', collapsed);
    btn.textContent = collapsed ? '⮞' : '⮜';
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    localStorage.setItem(KEY, collapsed ? '1' : '0');
  };

  apply(readSaved());

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Prevent double-fire (app.js has this block twice)
    if (e.__gaiaLeftNavToggleOnce) return;
    e.__gaiaLeftNavToggleOnce = true;

    if (mq.matches) return; // mobile ignores desktop collapse
    apply(!document.body.classList.contains('sidebar-collapsed'));
  });

  // When crossing breakpoint, re-apply saved desktop state
  try { mq.addEventListener('change', () => apply(readSaved())); }
  catch { mq.addListener(() => apply(readSaved())); }
});

document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;

  // Create mini rail once
  if (!sidebar.querySelector(".mini-rail")) {
    const rail = document.createElement("div");
    rail.className = "mini-rail";
    rail.innerHTML = `
      <button class="rail-btn" title="Create new space" data-rail="space">📁</button>
      <button class="rail-btn" title="New chat" data-rail="chat">✎</button>
      <button class="rail-btn" title="Search" data-rail="search">🔍</button>
    `;
    sidebar.insertBefore(rail, sidebar.children[1]);
  }

  const rail = sidebar.querySelector(".mini-rail");

  rail.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rail]");
    if (!btn) return;

    const type = btn.dataset.rail;

    if (type === "chat") {
      document.getElementById("new-chat")?.click();
    }

    if (type === "space") {
      // click existing "+ New space" if spaces.js renders it
      const candidates = [...document.querySelectorAll("button, a")]
        .filter(el => (el.textContent || "").toLowerCase().includes("new space"));
      candidates[0]?.click();
    }

    if (type === "search") {
      alert("Search coming next — tell me if you want chat list filtering or full modal search.");
    }
  });
});

/* =========================================================
   MOBILE DRAWERS (<= 900px)
   Uses: #drawerBackdrop + body.mobile-left-open / body.mobile-right-open
   Behavior:
   - Left arrow opens/closes sidebar
   - Right arrow opens/closes vault (#vault-panel)
   - Tap anywhere outside drawers closes them
   ========================================================= */
(function mobileDrawersV2(){
  const mq = window.matchMedia("(max-width: 900px)");

  document.addEventListener("DOMContentLoaded", () => {
    const leftBtn   = document.getElementById("mobile-open-left");
    const rightBtn  = document.getElementById("mobile-open-right");
    const backdrop  = document.getElementById("drawerBackdrop");
    const legacyOv  = document.getElementById("mobile-overlay"); // legacy overlay (we disable it)

    if (!leftBtn || !rightBtn || !backdrop) return;

    const isMobile = () => mq.matches;
    const leftPanel = () => document.getElementById("left-nav") || document.querySelector(".sidebar");
    const rightPanel = () => document.getElementById("vault-panel") || document.querySelector(".vault-panel");

    function setBackdrop(on){
      backdrop.hidden = !on;
      // hard-disable legacy overlay if it ever gets toggled elsewhere
      if (legacyOv) legacyOv.classList.remove("is-visible");
    }

    function closeAll(){
      document.body.classList.remove("mobile-left-open", "mobile-right-open");
      setBackdrop(false);
    }

    function openLeft(){
      // ensure right closed + remove desktop-collapsed states that break mobile
      document.body.classList.remove("mobile-right-open", "vault-collapsed", "right-mini");
      document.body.classList.remove("left-mini", "sidebar-collapsed", "left-collapsed");
      document.body.classList.add("mobile-left-open");
      setBackdrop(true);
    }

    function openRight(){
      // ensure left closed + remove desktop-collapsed states that break mobile
      document.body.classList.remove("mobile-left-open");
      document.body.classList.remove("vault-collapsed", "right-mini");
      document.body.classList.add("mobile-right-open");
      setBackdrop(true);
    }

    leftBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isMobile()) return;
      if (document.body.classList.contains("mobile-left-open")) closeAll();
      else openLeft();
    });

    rightBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isMobile()) return;
      if (document.body.classList.contains("mobile-right-open")) closeAll();
      else openRight();
    });

    // Tap backdrop closes
    backdrop.addEventListener("click", closeAll);

    // Tap anywhere outside drawers closes (your requested behavior)
    document.addEventListener("pointerdown", (e) => {
      if (!isMobile()) return;
      const anyOpen =
        document.body.classList.contains("mobile-left-open") ||
        document.body.classList.contains("mobile-right-open");
      if (!anyOpen) return;

      const t = e.target;
      const L = leftPanel();
      const R = rightPanel();

      if (leftBtn.contains(t) || rightBtn.contains(t)) return;
      if (L && L.contains(t)) return;
      if (R && R.contains(t)) return;

      closeAll();
    }, { capture: true });

    // ESC closes (useful in mobile emulation)
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAll();
    });

    // If resized to desktop, close drawers
    try { mq.addEventListener("change", () => { if (!isMobile()) closeAll(); }); }
    catch { mq.addListener(() => { if (!isMobile()) closeAll(); }); }

    // Start clean
    closeAll();
  });
})();



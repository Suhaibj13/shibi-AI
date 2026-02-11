// static/scripts/attachments.js
// GAIA Attachments Manager — supports BOTH legacy IDs and GAIA (+ menu) IDs.

export class AttachmentsManager {
  constructor(opts) {
    this.maxFiles = opts?.maxFiles ?? 10;
    this.maxSizeMB = opts?.maxSizeMB ?? 25;
    this.accept = opts?.accept ?? "*/*";
    this.files = []; // { id, file, name, size, type, icon }

    this.ui = {
      panel:
        document.querySelector("#attachments-panel") ||
        document.querySelector("#attach-chips") ||
        document.querySelector(".attach-chips"),
      input: document.querySelector("#file-input"),
      plusUpload: document.querySelector("#plus-upload"),
      count: document.querySelector("#attachments-count"),
    };

    // Global hook so vault (or other scripts) can attach files easily
    window.GAIA_ATTACHMENTS = this;

    this.#wire();
    this.render();
  }

  #wire() {
    // File input
    if (this.ui.input) {
      this.ui.input.setAttribute("accept", this.accept);
      this.ui.input.addEventListener("change", (e) => {
        const picked = Array.from(e.target.files || []);
        if (!picked.length) return;
        this.addFiles(picked);
        e.target.value = "";
      });
    }

    // + menu Upload button → open the same file input
    if (this.ui.plusUpload && this.ui.input) {
      this.ui.plusUpload.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.ui.input.click();
      });
    }
  }

  addFiles(fileList) {
    for (const f of fileList) {
      if (this.files.length >= this.maxFiles) break;

      const sizeMB = f.size / (1024 * 1024);
      if (sizeMB > this.maxSizeMB) continue;

      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.files.push({
        id,
        file: f,
        name: f.name,
        size: f.size,
        type: f.type || "application/octet-stream",
        icon: this.#iconFor(f.type, f.name),
      });
    }
    this.render();
  }

  // Attach a vault record that contains { data: Blob, name, type }
  addFromVaultRecord(rec) {
    if (!rec?.data || !(rec.data instanceof Blob)) return;
    const f = new File([rec.data], rec.name || "file", { type: rec.type || "application/octet-stream" });
    this.addFiles([f]);
  }

  remove(id) {
    this.files = this.files.filter((x) => x.id !== id);
    this.render();
  }

  clear() {
    this.files = [];
    this.render();
  }

  // Build multipart only when files exist
  buildFormDataIfAny(payload) {
    if (!this.files.length) return null;

    const fd = new FormData();
    fd.append("message", String(payload?.message ?? payload?.q ?? ""));

    // Keep these aligned with app.py (request.form.get(...))
    if (payload?.model) fd.append("model", String(payload.model));
    if (payload?.model_version) fd.append("model_version", String(payload.model_version));
    if (payload?.style) fd.append("style", String(payload.style));
    if (payload?.history != null) {
      fd.append("history", typeof payload.history === "string" ? payload.history : JSON.stringify(payload.history));
    }

    this.files.forEach((f) => fd.append("files[]", f.file, f.name));
    return fd;
  }

  render() {
    const host = this.ui.panel;
    if (!host) return;

    if (!this.files.length) {
      host.innerHTML = "";
      host.style.display = "none";
      if (this.ui.count) this.ui.count.textContent = "";
      return;
    }

    host.style.display = "";

    host.innerHTML = "";
    for (const f of this.files) {
      const el = document.createElement("div");
      el.className = "attach-chip";
      el.innerHTML = `
        <span class="chip-icon">${f.icon}</span>
        <span class="chip-name" title="${this.#esc(f.name)}">${this.#esc(this.#truncate(f.name, 28))}</span>
        <span class="chip-size">${this.#prettySize(f.size)}</span>
        <button class="chip-x" type="button" aria-label="Remove">&times;</button>
      `;
      el.querySelector(".chip-x")?.addEventListener("click", () => this.remove(f.id));
      host.appendChild(el);
    }

    if (this.ui.count) {
      this.ui.count.textContent = `${this.files.length} file${this.files.length > 1 ? "s" : ""} attached`;
    }
  }

  #iconFor(mime, name) {
    const lower = (name || "").toLowerCase();
    if ((mime || "").startsWith("image/")) return "🖼️";
    if (mime === "application/pdf" || lower.endsWith(".pdf")) return "📄";
    if ((mime || "").startsWith("text/") || /\.(txt|csv|log|md|json|yaml|yml|xml)$/i.test(lower)) return "📜";
    return "📎";
  }

  #prettySize(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  #truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 3) + "…" : s;
  }

  #esc(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }
}

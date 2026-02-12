# main.py (drop-in /ask)
from flask import Flask, render_template, request, jsonify, Response, stream_with_context, g
from dotenv import load_dotenv
import os, json, time, logging
from models import resolve  # GAIA V5 model resolver
from file_ai_router import route_and_answer

from model_versions_manual import get_versions_catalog, UI_MODEL_KEYS, resolve_selected_model_id
from low_cost_elm import est_messages_tokens, run_low_cost_elm

def safe_json(obj, status=200):
    return jsonify(obj), status

import logging
log = logging.getLogger(__name__)

load_dotenv()

app = Flask(__name__, static_url_path="/static", static_folder="static", template_folder="templates")

# secret key AFTER app is created (and safe if config/env missing)
try:
    import config
    app.secret_key = getattr(config, "SECRET_KEY", None) or os.environ.get("SECRET_KEY", "dev-secret")
except Exception:
    app.secret_key = os.environ.get("SECRET_KEY", "dev-secret")

#from providers import gemini_provider, groq_provider
#from providers import gemini_provider, groq_provider, openai_provider, anthropic_provider, cohere_provider
from providers import gemini_provider, groq_provider, openai_provider

# Optional providers (OpenAI/Anthropic/Cohere)
# NOTE: In this codebase these provider wrappers may live either:
#   1) inside the providers/ package  OR
#   2) as top-level modules (e.g. openai_provider.py).
# We support both so "ChatGPT" doesn't silently break.
openai_provider = anthropic_provider = cohere_provider = None

# Try providers/ package first
try:
    from providers import openai_provider as _openai_p
    openai_provider = _openai_p
except Exception as e:
    log.warning("OpenAI provider (providers/) not available: %s", e)

try:
    from providers import anthropic_provider as _anthropic_p
    anthropic_provider = _anthropic_p
except Exception as e:
    log.warning("Anthropic provider (providers/) not available: %s", e)

try:
    from providers import cohere_provider as _cohere_p
    cohere_provider = _cohere_p
except Exception as e:
    log.warning("Cohere provider (providers/) not available: %s", e)

# Fallback to top-level modules if present
if openai_provider is None:
    try:
        import openai_provider as _openai_p2
        openai_provider = _openai_p2
        log.info("OpenAI provider loaded from top-level openai_provider.py")
    except Exception as e:
        log.warning("OpenAI provider (top-level) not available: %s", e)

if anthropic_provider is None:
    try:
        import anthropic_provider as _anthropic_p2
        anthropic_provider = _anthropic_p2
        log.info("Anthropic provider loaded from top-level anthropic_provider.py")
    except Exception:
        pass

if cohere_provider is None:
    try:
        import cohere_provider as _cohere_p2
        cohere_provider = _cohere_p2
        log.info("Cohere provider loaded from top-level cohere_provider.py")
    except Exception:
        pass
import math, json  # make sure json is imported too

# --- Auth + Firestore (Mark2) ---
from gcp_auth_firestore import (
    init_firebase_admin,
    get_db,
    verify_bearer_token,
    auth_optional_enabled,
    ensure_user_doc,
)
from google.cloud import firestore

init_firebase_admin()
db = get_db()

def _require_auth_or_none():
    """Attempt to verify Bearer token; optionally enforce via GAIA_REQUIRE_AUTH=1."""
    decoded = verify_bearer_token(request.headers.get("Authorization", ""))
    if decoded:
        g.uid = decoded.get("uid")
        g.email = decoded.get("email", "")
        # name may not exist; keep empty
        g.name = decoded.get("name", "") or ""
        try:
            ensure_user_doc(g.uid, g.email, g.name)
        except Exception:
            pass
        return decoded

    g.uid = None
    g.email = ""
    g.name = ""
    return None

@app.before_request
def _auth_mw():
    # Allow unauth access to home + static + models list (UI must load first)
    p = request.path or ""
    if p.startswith("/static/") or p in ("/", "/models/versions"):
        _require_auth_or_none()
        return
    _require_auth_or_none()

def _uid():
    return getattr(g, "uid", None)

def _auth_required_or_401():
    if _uid():
        return None
    if auth_optional_enabled():
        return None
    return jsonify({"ok": False, "error": "auth_required"}), 401

# -------- Firestore helpers --------
def fs_new_chat(uid: str, title: str = "New chat", space_id: str = "default") -> str:
    ref = db.collection("chats").document()
    ref.set({
        "uid": uid,
        "title": title,
        "spaceId": space_id,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
        "pinned": False,
        "archived": False,
    })
    return ref.id

def fs_list_chats(uid: str, limit: int = 200):
    q = (db.collection("chats")
         .where("uid", "==", uid)
         .order_by("updatedAt", direction=firestore.Query.DESCENDING)
         .limit(limit))
    out = []
    for doc in q.stream():
        d = doc.to_dict() or {}
        d["id"] = doc.id
        out.append(d)
    return out

def fs_get_messages(uid: str, chat_id: str, limit: int = 400):
    chat = db.collection("chats").document(chat_id).get()
    if not chat.exists or (chat.to_dict() or {}).get("uid") != uid:
        return None
    q = (db.collection("chats").document(chat_id)
         .collection("messages")
         .order_by("createdAt")
         .limit(limit))
    out = []
    for doc in q.stream():
        d = doc.to_dict() or {}
        d["id"] = doc.id
        out.append(d)
    return out

def fs_add_message(uid: str, chat_id: str, role: str, content: str, meta=None):
    chat_ref = db.collection("chats").document(chat_id)
    snap = chat_ref.get()
    if not snap.exists or (snap.to_dict() or {}).get("uid") != uid:
        return False
    mref = chat_ref.collection("messages").document()
    mref.set({
        "uid": uid,
        "role": role,
        "content": content,
        "meta": meta or {},
        "createdAt": firestore.SERVER_TIMESTAMP,
    })
    chat_ref.set({"updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return True

def fs_touch_title(uid: str, chat_id: str, title: str):
    chat_ref = db.collection("chats").document(chat_id)
    snap = chat_ref.get()
    if not snap.exists or (snap.to_dict() or {}).get("uid") != uid:
        return False
    chat_ref.set({"title": title, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return True

FOLLOWUP_WORDS = {"explain", "elaborate", "more", "clarify", "details", "expand", "why"}

def _is_vague_followup(q: str) -> bool:
    s = (q or "").strip().lower()
    return len(s) <= 40 and any(w in s for w in FOLLOWUP_WORDS)

def _normalize_history(history):
    """role fix + drop empties + keep order"""
    norm = []
    for m in (history or []):
        role = m.get("role", "user")
        if role not in ("system", "user", "assistant"):
            role = "assistant" if role in ("ai", "assistant") else "user"
        text = (m.get("content") or "").strip()
        if text:
            norm.append({"role": role, "content": text})
    return norm

def build_messages(q: str, history=None, max_pairs: int = 8):
    """
    ChatGPT-style orchestration:
    - system guard
    - recency-biased window (last ~8 exchanges)
    - for vague follow-ups ("explain/elaborate"), anchor to the last assistant answer
    - append current user turn
    """
    msgs = [{
        "role": "system",
        "content": (
            "Answer using the most recent context. If the user asks to explain/elaborate/clarify "
            "in a short prompt, treat it as a follow-up to the immediately previous assistant answer. "
            "When you include any code, ALWAYS wrap it in triple backticks with a language tag "
            "(e.g., ```python, ```javascript, ```html, ```sql, ```json, ```yaml, ```bash)."
        )
    }]

    hist = _normalize_history(history)
    # --- PATCH: Hoist Space SOP (system entries in history) to the lead system message ---
    try:
        sys_texts = [m["content"] for m in hist if m.get("role") == "system"]
        if sys_texts:
            # Put SOP before the default guard so tone/instructions win
            msgs[0]["content"] = ("\n\n".join(sys_texts) + "\n\n" + msgs[0]["content"]).strip()
            # Drop system entries from the rest of history to avoid repeats/cropping issues
            hist = [m for m in hist if m.get("role") != "system"]
    except Exception:
        pass

    if _is_vague_followup(q):
        # Anchor to last assistant reply only
        last_assistant = next((m["content"] for m in reversed(hist) if m["role"] == "assistant"), "")
        if last_assistant:
            msgs.append({"role": "assistant", "content": last_assistant})
    else:
        # Sliding window of recent turns (≈ last 8 exchanges)
        tail = hist[-(max_pairs * 2):]
        msgs.extend(tail)

    msgs.append({"role": "user", "content": q})
    return msgs

def _sse(event: str, data) -> str:
    return f"event: {event}\n" f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

def _yield_in_words(text: str, delay: float = 0.0):
    buf = []
    for tok in (text or "").split(" "):
        buf.append(tok)
        if len(buf) >= 4:
            yield " ".join(buf) + " "
            buf = []
            if delay: time.sleep(delay)
    if buf:
        yield " ".join(buf) + " "

# valid model maps
GROQ_MODELS = {
    "grok": "llama-3.3-70b-versatile",
    "groq": "llama-3.3-70b-versatile",
    "llama-3.3-70b-versatile": "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant": "llama-3.1-8b-instant",
    "mixtral-8x7b-32768": "mixtral-8x7b-32768",
}
GEMINI_MODELS = {
    "gemini": "gemini-2.5-flash",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-pro": "gemini-2.5-pro",
}

def resolve_provider_and_model(raw_model: str):
    m = (raw_model or "").strip().lower()
    if m in GEMINI_MODELS: return ("gemini", GEMINI_MODELS[m])
    if m in GROQ_MODELS:   return ("groq", GROQ_MODELS[m])
    return ("groq", "llama-3.3-70b-versatile")

@app.get("/")
def index():
    return render_template("index.html")

# Put this near the top (after imports)
# UI_MODEL_KEYS is imported from model_versions_manual (single source of truth)
@app.get("/models/versions")
def models_versions():
    """Return cached latest versions per UI model key (refresh every 3 days)."""
    force = (request.args.get("force") == "1")
    data = get_versions_catalog(UI_MODEL_KEYS, max_versions=5, force=force)
    return jsonify({"ok": True, "data": data})


# ---------------- Auth + Chat APIs (Mark2) ----------------
@app.get("/api/me")
def api_me():
    if not _uid():
        if auth_optional_enabled():
            return jsonify({"ok": True, "user": None})
        return jsonify({"ok": False, "error": "auth_required"}), 401
    return jsonify({"ok": True, "user": {"uid": _uid(), "email": getattr(g, "email", "")}})

@app.get("/api/chats")
def api_list_chats():
    auth_err = _auth_required_or_401()
    if auth_err:
        return auth_err
    if not _uid():
        return jsonify({"ok": True, "data": []})
    chats = fs_list_chats(_uid(), limit=200)
    return jsonify({"ok": True, "data": chats})

@app.post("/api/chats")
def api_create_chat():
    if not _uid():
        return jsonify({"ok": False, "error": "auth_required"}), 401
    payload = request.get_json(silent=True) or {}
    title = (payload.get("title") or "New chat").strip()[:120]
    space_id = (payload.get("spaceId") or "default").strip()[:80]
    chat_id = fs_new_chat(_uid(), title=title, space_id=space_id)
    return jsonify({"ok": True, "id": chat_id})

@app.get("/api/chats/<chat_id>/messages")
def api_get_messages(chat_id):
    if not _uid():
        auth_err = _auth_required_or_401()
        if auth_err:
            return auth_err
        return jsonify({"ok": True, "data": []})
    msgs = fs_get_messages(_uid(), chat_id, limit=400)
    if msgs is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    return jsonify({"ok": True, "data": msgs})

@app.post("/api/chats/<chat_id>/messages")
def api_add_message(chat_id):
    if not _uid():
        return jsonify({"ok": False, "error": "auth_required"}), 401
    payload = request.get_json(silent=True) or {}
    role = (payload.get("role") or "").strip()
    content = (payload.get("content") or "").strip()
    meta = payload.get("meta") or {}
    if role not in ("user", "assistant", "system") or not content:
        return jsonify({"ok": False, "error": "bad_request"}), 400
    ok = fs_add_message(_uid(), chat_id, role, content, meta=meta)
    if not ok:
        return jsonify({"ok": False, "error": "not_found"}), 404
    return jsonify({"ok": True})




CHEAP_FALLBACK_BY_PROVIDER = {
    "groq":      "llama-3.1-8b-instant",
    "openai":    "gpt-4o",
    "anthropic": "claude-3-haiku-20240307",
    "gemini":    "gemini-2.5-flash",
    "cohere":    "command-r",
}

def make_reply(q: str, model_key: str = "grok", model_version: str = "", history=None):
    rm = resolve(model_key)
    provider = rm.provider
    # If the UI provided an explicit model version, prefer it; otherwise use resolver default.
    # Pick model id:
    # - if user explicitly picked a version -> use it
    # - if "latest" (empty) -> use the first version from versions catalog if available
    chosen_model = None

    # normalize model_version
    mv = (model_version or "").strip()
    if mv.lower() == "latest":
        mv = ""

    # If UI sends labels (e.g., "5.2-codex"), try mapping label -> id from cached catalog

    if mv:
        mv = resolve_selected_model_id(model_key, mv)

    model = (mv or rm.model_id)


    messages = build_messages(q, history)

    # Gemini is sometimes more consistent if it receives a flattened prompt, with system first.
    # Provide a flattened prompt for ALL providers (prevents OpenAI wrapper returning empty on None prompt)
    prompt_text_for_best = "\n".join(f"{m['role']}: {m['content']}" for m in messages)

    def _normalize_out(out, mid):
        # Provider wrappers may return dict or plain text
        if isinstance(out, dict):
            # Ensure keys exist
            if "reply" not in out:
                out["reply"] = out.get("text", "") or ""
            if "model" not in out:
                out["model"] = mid
            return out
        if isinstance(out, str):
            return {"reply": out.strip(), "model": mid}
        return {"reply": str(out), "model": mid}

    def _call(pv, mid, msgs, prompt_text=None):
        if pv == "gemini":
            return _normalize_out(gemini_provider.generate(mid, prompt_text, msgs), mid)
        if pv == "groq":
            return _normalize_out(groq_provider.generate(mid, prompt_text, msgs), mid)
        if pv == "openai":
            if openai_provider is None:
                raise RuntimeError("OpenAI provider is not configured/loaded. Check OPENAI_API_KEY.")
            return _normalize_out(openai_provider.generate(mid, prompt_text, msgs), mid)
        if pv == "anthropic":
            if anthropic_provider is None:
                raise RuntimeError("Anthropic provider is not configured/loaded.")
            return _normalize_out(anthropic_provider.generate(mid, prompt_text, msgs), mid)
        if pv == "cohere":
            if cohere_provider is None:
                raise RuntimeError("Cohere provider is not configured/loaded.")
            return _normalize_out(cohere_provider.generate(mid, prompt_text, msgs), mid)
        raise RuntimeError(f"Unknown provider '{pv}'")


    def _call_for_model(mid, msgs):
        # For Gemini, pass flattened prompt; for others, pass structured messages.
        if provider == "gemini":
            pt = "\n".join(f"{m['role']}: {m['content']}" for m in msgs)
            return _call(provider, mid, msgs, pt)
        return _call(provider, mid, msgs, None)

    used_model = model

    # =========================
    # Low-cost ELM (token saver)
    # =========================
    # If the prompt+history is heavy, compress with a cheap model and then elaborate with the selected model.
    # This keeps output quality closer to the expensive model while reducing expensive-token usage.
    try:
        total_tokens_est = est_messages_tokens(messages)
    except Exception:
        total_tokens_est = 0

    if total_tokens_est >= 500:
        # Pull latest 5 versions (cached for 3 days) and pick the cheapest-ish summarizer.
        # Preference order:
        # 1) 5th version from the dropdown list (oldest) if available
        # 2) provider cheap fallback
        try:
            cat = get_versions_catalog([model_key], max_versions=5) or {}
            vers = (cat.get(model_key) or {}).get("versions") or []
            cheap_model = (vers[-1].get("id") if len(vers) >= 5 else None) or CHEAP_FALLBACK_BY_PROVIDER.get(provider, model)
        except Exception:
            cheap_model = CHEAP_FALLBACK_BY_PROVIDER.get(provider, model)

        try:
            final_text = run_low_cost_elm(
                call_fn=lambda mid, msgs: _call_for_model(mid, msgs),
                cheap_model=cheap_model,
                expensive_model=model,
                messages=messages,
                user_question=q
            )
            return {"reply": final_text, "model_used": model}
        except Exception:
            # If ELM fails for any reason, fall back to normal single call (never break the chat).
            pass

    # Normal single call path
    try:
        result = _call(provider, model, messages, prompt_text_for_best)
        used_model = (result.get("model") if isinstance(result, dict) else None) or model
    except Exception as e1:
        cheap = CHEAP_FALLBACK_BY_PROVIDER.get(provider)
        if not cheap:
            return {"reply": f"Error from {provider} ({model}): {e1}", "model_used": used_model}
        try:
            # compact prompt for widest provider compatibility
            prompt = "\n".join(f"{m['role']}: {m['content']}" for m in messages)
            result = _call(provider, cheap, [], prompt)  # retry with CHEAP for same provider
            used_model = (result.get("model") if isinstance(result, dict) else None) or cheap
        except Exception as e2:
            return {"reply": f"Error from {provider} ({model}) and fallback ({cheap}): {e2}", "model_used": used_model}

    text = (result.get("reply") if isinstance(result, dict) else "") or ""
    if not str(text).strip():
        text = f"Error: empty response from {provider} ({used_model}). Check provider wrapper + API key + model id."
    return {"reply": text, "model_used": used_model}


@app.post("/ask")
def ask():
    try:
        ctype = (request.content_type or "").lower()

        # ---- 1) multipart/form-data (attachments) ----
        if ctype.startswith("multipart/form-data"):
            message = (request.form.get("message") or "").strip()
            logical_model = (request.form.get("model") or "grok").strip().lower()
            model_version = (request.form.get("model_version") or "").strip()
            style = (request.form.get("style") or "simple").strip().lower()
            files = request.files.getlist("files[]") if request.files else []
            # NEW: optional compact history from client
            try:
                history = json.loads(request.form.get("history") or "[]")
            except Exception:
                history = []

            if not message and not files:
                return jsonify({"ok": True, "reply": "Please type a question."})

            # Route files (always), regardless of provider label
            # If history exists, prepend a compact context block for the file-answering path
            if history:
                try:
                    # Keep it tiny and safe: only role/content, last ~8 turns already compacted on client
                    hist_txt = "\n".join([f"{m.get('role','user')}: {m.get('content','')}" for m in history][-16:])
                    message_with_ctx = (f"Context (recent turns):\n{hist_txt}\n\nUser:\n{message}").strip()
                except Exception:
                    message_with_ctx = message
            else:
                message_with_ctx = message

            # --- PATCH: prepend Space SOP (system entries) for the file-answering path ---
            try:
                sys_texts = [m.get("content","") for m in (history or []) if m.get("role") == "system"]
                if sys_texts:
                    message_with_ctx = ("System instruction:\n" + "\n\n".join(sys_texts) + "\n\n" + message_with_ctx).strip()
            except Exception:
                pass

            # Build messages for the file path as well (so follow-ups like "explain" stay on the last answer)
            _ = build_messages(message, history)

            try:
                out = route_and_answer(message_with_ctx, files, logical_model_key=logical_model, model_version=model_version)
            except TypeError:
                out = route_and_answer(message_with_ctx, files, logical_model_key=logical_model)

            rm = resolve(logical_model)
            used_model = (out.get("model_used") or (out.get("meta") or {}).get("model_used")
                        or (model_version or CHEAP_FALLBACK_BY_PROVIDER.get(rm.provider, rm.model_id)))
            return jsonify({"ok": True, "reply": out.get("reply", ""), "model": used_model})

        # ---- 2) JSON path (no attachments) ----
        payload = request.get_json(silent=True) or {}
        q = (payload.get("message") or payload.get("q") or payload.get("query") or "").strip()
        model_key = (payload.get("model") or "grok").strip().lower()
        model_version = (payload.get("model_version") or "").strip()
        history = payload.get("history") or []

        if not q:
            return jsonify({"ok": True, "reply": "Please type a question."})

        res = make_reply(q, model_key=model_key, model_version=model_version, history=history)

        chat_id = (payload.get("chatId") or "").strip()
        if _uid() and chat_id:
            try:
                fs_add_message(_uid(), chat_id, "user", q, meta={"model_key": model_key, "model_version": model_version})
                fs_add_message(_uid(), chat_id, "assistant", res.get("reply","") or "", meta={"model": res.get("model_used")})
            except Exception:
                pass

        return jsonify({
            "ok": True,
            "reply": res.get("reply", ""),
            "model": res.get("model_used") or resolve(model_key).model_id
        })

    except Exception as e:
        # Always return JSON, never let an HTML error page reach the client
        return jsonify({"ok": False, "reply": f"Error: {e}"}), 500


@app.route("/ask/stream", methods=["GET"])
def ask_stream():
    q = (request.args.get("q") or "").strip()

    # NEW: optional history for SSE (memory!)
    raw_hist = request.args.get("history") or "[]"
    model_key = (request.args.get("model") or "grok").strip().lower()
    model_version = (request.args.get("model_version") or "").strip()
    chat_id = (request.args.get("chatId") or "").strip()
    try:
        history = json.loads(raw_hist)
    except Exception:
        history = []

    if not q:
        def _err():
            yield _sse("error", {"message": "Please type a question."})
            yield _sse("done", {"ok": False})
        return Response(stream_with_context(_err()),
                        mimetype="text/event-stream",
                        headers={
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
                            "X-Accel-Buffering": "no",
                        })

    @stream_with_context
    def event_stream():
        try:
            res = make_reply(q, model_key=model_key, model_version=model_version, history=history)

            if isinstance(res, dict):
                final_text = (res.get("reply") or "").strip()
                used_model = res.get("model_used") or (model_version or resolve(model_key).model_id)
            else:
                final_text = (res or "").strip()
                used_model = (model_version or resolve(model_key).model_id)

            # tell the UI which model actually produced this message
            yield _sse("start", {"ok": True, "model": used_model})

            # stream the text
            for chunk in _yield_in_words(final_text, delay=0.0):
                yield _sse("delta", {"text": chunk})

            # stream_persist: store final messages if authed
            if _uid() and chat_id:
                try:
                    fs_add_message(_uid(), chat_id, "user", q, meta={"via":"sse","model_key": model_key, "model_version": model_version})
                    fs_add_message(_uid(), chat_id, "assistant", final_text, meta={"model": used_model})
                except Exception:
                    pass

            yield _sse("done", {"ok": True})

        except Exception as e:
            yield _sse("gaia_error", {"ok": False, "error": str(e)})
            yield _sse("done", {"ok": False})

    return Response(event_stream(),
                    mimetype="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)

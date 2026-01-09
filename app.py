# main.py (drop-in /ask)
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import os
from models import resolve  # GAIA V5 model resolver
from file_ai_router import route_and_answer
from flask import jsonify
from flask import Response, stream_with_context, request
import json, time

def safe_json(obj, status=200):
    return jsonify(obj), status

import logging
log = logging.getLogger(__name__)

load_dotenv()
app = Flask(__name__, static_url_path="/static", static_folder="static", template_folder="templates")

import config
app.secret_key = config.SECRET_KEY

#from providers import gemini_provider, groq_provider
from providers import gemini_provider, groq_provider, openai_provider, anthropic_provider, cohere_provider
import math, json  # make sure json is imported too

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
            #"You are a neutral assistant. Do not mention your model or vendor name "
            #"(e.g., Gemini, Claude, GPT, Groq) unless the user explicitly asks. "
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

CHEAP_FALLBACK_BY_PROVIDER = {
    "groq":      "llama-3.1-8b-instant",
    "openai":    "gpt-4o",
    "anthropic": "claude-3-haiku-20240307",
    "gemini":    "gemini-2.5-flash",
    "cohere":    "command-r",
}

def make_reply(q: str, model_key: str = "grok", history=None):
    rm = resolve(model_key)
    provider, model = rm.provider, rm.model_id
    messages = build_messages(q, history)

    # --- PATCH: ensure Gemini sees the SOP up front ---
    prompt_text_for_best = None
    if provider == "gemini":
        # Flatten messages (system first) so Gemini treats SOP as instruction
        prompt_text_for_best = "\n".join(f"{m['role']}: {m['content']}" for m in messages)

    def _call(pv, mid, msgs, prompt_text=None):
        if pv == "gemini":    return gemini_provider.generate(mid, prompt_text, msgs)
        if pv == "groq":      return groq_provider.generate(mid, prompt_text, msgs)
        if pv == "openai":    return openai_provider.generate(mid, prompt_text, msgs)
        if pv == "anthropic": return anthropic_provider.generate(mid, prompt_text, msgs)
        if pv == "cohere":    return cohere_provider.generate(mid, prompt_text, msgs)
        raise RuntimeError(f"Unknown provider '{pv}'")

    used_model = model
    try:
        # pass the joined prompt for Gemini; others keep role-structured messages
        result = _call(provider, model, messages, prompt_text_for_best)
        used_model = (result.get("model") if isinstance(result, dict) else None) or model

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
            return {"reply": f"Error from {provider} ({model}) and fallback ({cheap}): {e2}",
                    "model_used": used_model}

    text = (result.get("reply") if isinstance(result, dict) else "") or ""
    return {"reply": text, "model_used": used_model}





@app.post("/ask")
def ask():
    try:
        ctype = (request.content_type or "").lower()

        # ---- 1) multipart/form-data (attachments) ----
        if ctype.startswith("multipart/form-data"):
            message = (request.form.get("message") or "").strip()
            logical_model = (request.form.get("model") or "grok").strip().lower()
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
            msgs = build_messages(message, history)
            out = route_and_answer(message_with_ctx, files, logical_model_key=logical_model)
            # after the route_and_answer(...) call
            rm = resolve(logical_model)
            used_model = (out.get("model_used") or (out.get("meta") or {}).get("model_used")
                        or CHEAP_FALLBACK_BY_PROVIDER.get(rm.provider, rm.model_id))
            return jsonify({"ok": True, "reply": out.get("reply", ""), "model": used_model})

            # If no files (unexpected here), fall through to JSON path

        # ---- 2) JSON path (no attachments) ----
        payload = request.get_json(silent=True) or {}
        q = (payload.get("message") or payload.get("q") or payload.get("query") or "").strip()
        model_key = (payload.get("model") or "grok").strip().lower()
        history = payload.get("history") or []

        if not q:
            return jsonify({"ok": True, "reply": "Please type a question."})

        # IMPORTANT: define `res` before using it
        res = make_reply(q, model_key=model_key, history=history)   # returns {"reply": ..., "model_used": ...}

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
            res = make_reply(q, model_key=model_key, history=history)

            if isinstance(res, dict):
                final_text = (res.get("reply") or "").strip()
                used_model = res.get("model_used") or resolve(model_key).model_id
            else:
                # legacy shape: make_reply returned a string
                final_text = (res or "").strip()
                used_model = resolve(model_key).model_id

            # tell the UI which model actually produced this message
            yield _sse("start", {"ok": True, "model": used_model})

            # stream the text
            for chunk in _yield_in_words(final_text, delay=0.0):
                yield _sse("delta", {"text": chunk})

            yield _sse("done", {"ok": True})

        except Exception as e:
            yield _sse("error", {"ok": False, "error": str(e)})
            yield _sse("done", {"ok": False})


    return Response(event_stream(),
                    mimetype="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    })


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=False)

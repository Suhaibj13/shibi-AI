"""
GAIA — Manual model version control (single source of truth)

WHY YOU SAW THAT ERROR
----------------------
In PowerShell, typing a URL like:
  http://127.0.0.1:8080/models/versions
tries to RUN it as a command, so you get "CommandNotFoundException".

Use ONE of these instead:
  - PowerShell:
      irm http://127.0.0.1:8080/models/versions | ConvertTo-Json -Depth 10
      # OR
      curl.exe http://127.0.0.1:8080/models/versions
  - CMD:
      curl http://127.0.0.1:8080/models/versions

===========================================================
SECTION A — "CMD/PowerShell scripts" to FETCH LATEST VERSIONS
===========================================================
These are *copy/paste* commands (they run locally). They DO NOT change GAIA automatically.
You will copy the output model ids into SECTION B below.

NOTE:
- Set your keys first (PowerShell examples):
    $env:OPENAI_API_KEY="..."
    $env:GOOGLE_API_KEY="..."
    $env:GROQ_API_KEY="..."
    $env:ANTHROPIC_API_KEY="..."
    $env:COHERE_API_KEY="..."

A1) OpenAI (list available models)
----------------------------------
# Uses the OpenAI python SDK v1.x
python - << 'PY'
import os
from openai import OpenAI
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
models = client.models.list().data
for m in sorted(models, key=lambda x: x.id):
    print(m.id)
PY

A2) Google Gemini (list available models)
-----------------------------------------
python - << 'PY'
import os, google.generativeai as genai
genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))
for m in genai.list_models():
    # m.name usually looks like: "models/gemini-2.5-pro"
    print(m.name)
PY

A3) Groq (list available models)
--------------------------------
python - << 'PY'
import os
from groq import Groq
client = Groq(api_key=os.getenv("GROQ_API_KEY"))
# API shape can vary by SDK version; this is the most common:
try:
    models = client.models.list().data
    for m in sorted(models, key=lambda x: x.id):
        print(m.id)
except Exception as e:
    print("Could not list models from SDK:", e)
PY

A4) Anthropic Claude (list available models)
--------------------------------------------
python - << 'PY'
import os
import anthropic
client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
try:
    models = client.models.list().data
    for m in models:
        print(m.id)
except Exception as e:
    print("Anthropic SDK does not always expose models.list(); error:", e)
    print("If this fails, use Anthropic docs/dashboard and paste the model ids manually.")
PY

A5) Cohere (list available models)
----------------------------------
python - << 'PY'
import os
from cohere import ClientV2
c = ClientV2(api_key=os.getenv("COHERE_API_KEY"))
try:
    models = c.models.list()
    # SDK may return dicts or objects depending on version
    for m in models.get("models", []) if isinstance(models, dict) else (models.models or []):
        mid = m.get("id") if isinstance(m, dict) else getattr(m, "id", None)
        if mid: print(mid)
except Exception as e:
    print("Cohere SDK model listing may differ by version:", e)
PY

===========================================================
SECTION B — MANUAL MODEL/VERSION CONFIG (EDIT THIS)
===========================================================
This is the ONLY place you should control:
- which "3 versions" appear in the UI (best / good / cheap)
- what label shows in the dropdown (clean label mapping)
- which concrete model id GAIA uses when user selects a version

RULES:
- Put concrete provider model ids in "id"
- Put UI label you want in "label" (ex: "5.2", "2.5-pro", etc.)
- Add EXACTLY 3 versions per model in the order you want them displayed:
    1) best
    2) good
    3) cheap
- "default" controls what "latest" means in the UI (when version dropdown is blank).
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, List, Optional

import re

def _auto_label(model_id: str) -> str:
    """Best-effort clean label from a raw provider model id."""
    s = (model_id or '').strip()
    if not s:
        return ''
    s2 = s.replace('models/', '')
    m = re.search(r'(?:gpt[-_]?|gemini[-_]?)(\d+(?:\.\d+)*)(?:[-_].*)?$', s2, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r'^(llama|mixtral)[-_]?(.*)$', s2, re.IGNORECASE)
    if m:
        fam = m.group(1).lower()
        rest = m.group(2).replace('-', ' ').replace('_', ' ').strip()
        return f"{fam} {rest}".strip()
    return s2


# These keys MUST match the <select id="model"> option values in index.html
UI_MODEL_KEYS: List[str] = ["gpt-5", "gemini-pro", "grok", "claude-sonnet", "cohere-plus"]

# --------------------------------------------------------------------
# EDIT HERE: your manual versions + dropdown labels
# --------------------------------------------------------------------
# NOTE: Replace the "id" values with REAL ids you fetched from SECTION A.
# The examples below are placeholders.
MANUAL_CATALOG: Dict[str, Dict] = {
    # OpenAI / ChatGPT
    "gpt-5": {
        "provider": "openai",
        "default": "best",  # "best" | "good" | "cheap" | or explicit model id
        "versions": [
            {"tier": "best",  "id": "gpt-5.2-pro-2025-12-11", "label": "5.2"},
            {"tier": "good",  "id": "gpt-5.1-2025-11-13", "label": "5.1"},
            {"tier": "cheap", "id": "gpt-5-2025-08-07",   "label": "5.0"},
        ],
    },

    # Google Gemini
    "gemini-pro": {
        "provider": "gemini",
        "default": "best",
        "versions": [
            {"tier": "best",  "id": "gemini-2.5-pro",   "label": "2.5 Pro"},
            {"tier": "good",  "id": "gemini-2.5-flash", "label": "2.5 Flash"},
            {"tier": "cheap", "id": "gemini-1.5-flash", "label": "1.5 Flash"},
        ],
    },

    # Groq (your "grok" UI key maps to groq provider in your resolver)
    "grok": {
        "provider": "groq",
        "default": "best",
        "versions": [
            {"tier": "best",  "id": "llama-3.3-70b-versatile", "label": "Llama 3.3 70B"},
            {"tier": "good",  "id": "mixtral-8x7b-32768",      "label": "Mixtral 8x7B"},
            {"tier": "cheap", "id": "llama-3.1-8b-instant",    "label": "Llama 3.1 8B"},
        ],
    },

    # Anthropic
    "claude-sonnet": {
        "provider": "anthropic",
        "default": "best",
        "versions": [
            {"tier": "best",  "id": "claude-3-5-sonnet-20240620", "label": "Sonnet"},
            {"tier": "good",  "id": "claude-3-opus-20240229",     "label": "Opus"},
            {"tier": "cheap", "id": "claude-3-haiku-20240307",    "label": "Haiku"},
        ],
    },

    # Cohere
    "cohere-plus": {
        "provider": "cohere",
        "default": "best",
        "versions": [
            {"tier": "best",  "id": "command-r-plus", "label": "R+ (best)"},
            {"tier": "good",  "id": "command-r",      "label": "R (good)"},
            {"tier": "cheap", "id": "command",        "label": "Command (cheap)"},
        ],
    },
}

# --------------------------------------------------------------------
# DO NOT EDIT BELOW (backend helpers)
# --------------------------------------------------------------------

def _normalize_model_key(k: str) -> str:
    return (k or "").strip().lower()

def get_versions_catalog(model_keys: List[str], max_versions: int = 5, force: bool = False) -> Dict[str, Dict]:
    """
    Backward-compatible with the old model_versions_service.get_versions_catalog API.

    Returns:
      {
        "<ui_key>": {
          "provider": "...",
          "default": "best",
          "versions": [ {"id": "...", "label": "...", "tier": "best"}, ... ]
        },
        ...
      }
    """
    out: Dict[str, Dict] = {}
    for raw in (model_keys or []):
        k = _normalize_model_key(raw)
        entry = MANUAL_CATALOG.get(k)
        if not entry:
            out[k] = {"provider": "", "default": "best", "versions": []}
            continue

        vers = (entry.get("versions") or [])[:max_versions]
        # De-dupe by id (prevents duplicate options in the UI if config repeats)
        seen = set()
        deduped = []
        for v in vers:
            vid = (v.get('id') or '').strip()
            if not vid or vid in seen:
                continue
            seen.add(vid)
            deduped.append(v)
        vers = deduped
        # Ensure labels are always present
        cleaned = []
        for v in vers:
            vid = (v.get("id") or "").strip()
            lab = (v.get("label") or "").strip() or _auto_label(vid)
            cleaned.append({"id": vid, "label": lab, "tier": v.get("tier", "")})
        out[k] = {
            "provider": entry.get("provider", ""),
            "default": entry.get("default", "best"),
            "versions": cleaned,
        }
    return out

def resolve_selected_model_id(model_key: str, selected: str = "") -> str:
    """
    Given UI model key + the selected version (either an id OR a label),
    return the concrete provider model id.

    selected can be:
      - "" / "latest" => uses entry["default"] tier (best/good/cheap) or the first version
      - exact id       => returned as-is (if present in the catalog)
      - label          => mapped to its id
    """
    k = _normalize_model_key(model_key)
    entry = MANUAL_CATALOG.get(k) or {}
    versions = entry.get("versions") or []

    sel = (selected or "").strip()
    if not sel or sel.lower() == "latest":
        default = (entry.get("default") or "best").strip().lower()
        if default in ("best", "good", "cheap"):
            hit = next((v for v in versions if (v.get("tier") or "").lower() == default), None)
            if hit and hit.get("id"):
                return hit["id"]
        # fallback: first version
        return (versions[0].get("id") if versions else "")

    # if sel is a tier name
    if sel.lower() in ("best", "good", "cheap"):
        hit = next((v for v in versions if (v.get("tier") or "").lower() == sel.lower()), None)
        if hit and hit.get("id"):
            return hit["id"]

    # exact id match
    hit = next((v for v in versions if (v.get("id") or "") == sel), None)
    if hit and hit.get("id"):
        return hit["id"]

    # label match
    hit = next((v for v in versions if (v.get("label") or "").strip().lower() == sel.lower()), None)
    if hit and hit.get("id"):
        return hit["id"]

    # no match: return as-is (lets power-users try raw ids)
    return sel

def pick_cheap_model_id(model_key: str) -> Optional[str]:
    k = _normalize_model_key(model_key)
    entry = MANUAL_CATALOG.get(k) or {}
    versions = entry.get("versions") or []
    hit = next((v for v in versions if (v.get("tier") or "").lower() == "cheap"), None)
    return (hit.get("id") if hit else None) or (versions[-1].get("id") if versions else None)

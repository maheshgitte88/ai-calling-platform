"""
Recover stuck calls: generate summary and extracted_fields for calls that have
transcript_entries but are still in-progress (e.g. timeout, user hung up before
summary could run).

Usage:
  python recover_stuck_calls.py              # recover all stuck calls
  python recover_stuck_calls.py <call_id>    # recover single call
"""
import asyncio
import json
import logging
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env")

from pymongo import MongoClient

# Share summary logic with agent
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/ai_calling")
_db_name = "ai_calling"
if "/" in MONGODB_URI.split("?")[0]:
    _db_name = MONGODB_URI.split("/")[-1].split("?")[0] or _db_name
mongo = MongoClient(MONGODB_URI)
db = mongo[_db_name]


def _now_iso():
    return datetime.utcnow().isoformat() + "Z"


async def _generate_summary(transcript: str, summary_prompt: str, extraction_schema: dict, api_key: str | None = None) -> tuple[str, dict]:
    """Generate summary and extracted fields using Gemini."""
    try:
        from google import genai
        key = (api_key or "").strip() or os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if not key or key == "***":
            logging.warning("[Summarizer] No valid API key")
            return "", {}
        client = genai.Client(api_key=key)
        prompt = f"""
You are a call analyst.

{summary_prompt}

Extraction schema (field -> meaning):
{json.dumps(extraction_schema, indent=2)}

Transcript:
{transcript}

Return strict JSON only:
{{ "summary": "concise call summary", "extracted": {{ "fieldName": "value" }} }}
"""
        r = client.models.generate_content(model="gemini-2.5-flash-lite", contents=prompt)
        text = (getattr(r, "text", "") or "").strip()
        cleaned = re.sub(r"^```json\s*", "", text).strip()
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
        parsed = json.loads(cleaned)
        return parsed.get("summary", ""), parsed.get("extracted", {})
    except Exception as e:
        logging.error("[Summarizer] Error: %s", e, exc_info=True)
        return "", {}


async def recover_call(call_id: str) -> bool:
    """Recover a single call: generate summary from transcript_entries and mark completed."""
    call = db.calls.find_one({"id": call_id})
    if not call:
        logging.error("Call not found: %s", call_id)
        return False
    status = call.get("status")
    has_summary = bool((call.get("summary") or "").strip())
    if has_summary:
        logging.info("Call %s already has summary, skipping", call_id)
        return False
    if status not in ("in-progress", "dispatched", "completed", "failed"):
        logging.info("Call %s status=%s, skipping (unsupported status)", call_id, status)
        return False

    entries = list(db.transcript_entries.find({"call_id": call_id}).sort("created_at", 1))
    transcript_text = "\n".join(
        f"{e.get('role', 'user')}: {e.get('text', '')}"
        for e in entries
        if e.get("is_final", True) and (e.get("text") or "").strip()
    ).strip()
    if not transcript_text:
        transcript_text = "\n".join(
            f"{e.get('role', 'user')}: {e.get('text', '')}"
            for e in entries
            if (e.get("text") or "").strip()
        ).strip()

    if not transcript_text:
        logging.warning("Call %s has no transcript entries", call_id)
        return False

    client = db.clients.find_one({"id": call["client_id"]})
    if not client:
        logging.error("Client not found for call %s", call_id)
        return False

    config = db.client_configs.find_one({"client_id": call["client_id"]}) or {}
    llm_cfg = config.get("llm", {})
    summary_api_key = None
    if llm_cfg.get("provider") == "gemini" and (llm_cfg.get("apiKey") or "").strip() and llm_cfg.get("apiKey") != "***":
        summary_api_key = llm_cfg.get("apiKey")

    summary_prompt = client.get("summary_prompt") or "Summarize the call."
    extraction_schema = client.get("extraction_schema") or {}

    summary, extracted = await _generate_summary(
        transcript_text, summary_prompt, extraction_schema, api_key=summary_api_key
    )
    if not (summary or "").strip() and not extracted:
        logging.error("Call %s summary generation returned empty output", call_id)
        return False

    db.calls.update_one(
        {"id": call_id},
        {
            "$set": {
                "status": "completed",
                "transcript": transcript_text,
                "summary": summary,
                "extracted_fields": extracted,
                "error": None,
                "updated_at": _now_iso(),
            }
        },
    )
    logging.info("Recovered call %s: summary=%d chars, extracted=%d fields", call_id, len(summary), len(extracted))
    return True


async def main():
    logging.basicConfig(level=logging.INFO)
    call_id = sys.argv[1] if len(sys.argv) > 1 else None

    if call_id:
        ok = await recover_call(call_id)
        raise SystemExit(0 if ok else 2)

    # Find stuck calls: in-progress with transcript_entries, last entry > 2 min ago
    cutoff = (datetime.utcnow() - timedelta(minutes=2)).isoformat() + "Z"
    calls = list(db.calls.find({"status": "in-progress"}))
    recovered = 0
    for call in calls:
        cid = call["id"]
        last_entry = db.transcript_entries.find_one(
            {"call_id": cid},
            sort=[("created_at", -1)],
            projection={"created_at": 1},
        )
        if not last_entry:
            continue
        if last_entry.get("created_at", "") < cutoff:
            if await recover_call(cid):
                recovered += 1
    logging.info("Recovered %d stuck call(s)", recovered)


if __name__ == "__main__":
    asyncio.run(main())

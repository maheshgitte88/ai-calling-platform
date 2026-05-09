"""HTTP service for retroactive interview summary generation.

Why this exists
---------------
The live LiveKit agent runs ``generate_structured_evaluation`` and
persists the result at the end of ``run_interview``. If the agent dies
before that final step (dispatch cancellation, network blip, OOM, etc.)
the transcript is still safe in MongoDB but the ``interview_evaluations``
collection has no document. This HTTP service rebuilds the evaluation
from the stored transcript using the exact same pipeline as the live
agent.

Run with::

    python evaluator_app.py
    EVALUATOR_PORT=8090 python evaluator_app.py
"""

from __future__ import annotations

import logging
import os

from aiohttp import web

from app.config import settings
from app.db import get_db
from app.evaluation import generate_structured_evaluation
from app.logging_setup import configure_logging
from app.provider_resolver import resolve_provider_cfg
from app.runner import _persist_evaluation

configure_logging()
logger = logging.getLogger(__name__)

routes = web.RouteTableDef()


def _load_transcript_lines(db, session_id: str) -> list[dict]:
    """Pull persisted transcript events from MongoDB and unwrap their payloads.

    The agent stores each line as ``{type: "transcript", payload: {role, text, is_final, created_at}}``;
    the evaluator only needs the inner payload list, in chronological order.
    """
    docs = list(
        db.interview_events.find({"session_id": session_id, "type": "transcript"}).sort(
            "created_at", 1
        )
    )
    return [doc.get("payload") or {} for doc in docs]


@routes.get("/health")
async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "service": "interview-evaluator"})


@routes.post("/evaluate/{session_id}")
async def evaluate(request: web.Request) -> web.Response:
    session_id = (request.match_info.get("session_id") or "").strip()
    if not session_id:
        return web.json_response({"error": "session_id required"}, status=400)

    db = get_db()
    session = db.interview_sessions.find_one({"session_id": session_id})
    if not session:
        return web.json_response({"error": "session_not_found"}, status=404)

    transcript_lines = _load_transcript_lines(db, session_id)
    if not transcript_lines:
        return web.json_response(
            {"error": "no_transcript", "message": "No transcript events for this session"},
            status=409,
        )

    meta = session.get("metadata") or {}
    provider_cfg = resolve_provider_cfg(meta, settings)

    candidate_id = session.get("candidate_id") or ""
    interview_id = session.get("interview_id") or ""

    logger.info(
        "[Evaluator] Re-evaluating session=%s candidate=%s interview=%s lines=%d",
        session_id,
        candidate_id,
        interview_id,
        len(transcript_lines),
    )

    try:
        eval_doc = await generate_structured_evaluation(
            transcript_lines=transcript_lines,
            meta=meta,
            provider_cfg=provider_cfg,
        )
    except Exception as exc:  # noqa: BLE001 - we want to surface the message to the caller
        logger.exception("[Evaluator] generate_structured_evaluation failed: %s", exc)
        return web.json_response(
            {"error": "evaluation_failed", "message": str(exc)},
            status=502,
        )

    try:
        _persist_evaluation(
            db,
            session_id=session_id,
            candidate_id=candidate_id,
            interview_id=interview_id,
            eval_doc=eval_doc,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("[Evaluator] persistence failed: %s", exc)
        return web.json_response(
            {"error": "persist_failed", "message": str(exc)},
            status=500,
        )

    return web.json_response(
        {
            "ok": True,
            "session_id": session_id,
            "summary": eval_doc.get("summary"),
            "overallPercent": eval_doc.get("overallPercent"),
            "recommendation": eval_doc.get("recommendation"),
            "questionStats": eval_doc.get("questionStats"),
        }
    )


def make_app() -> web.Application:
    app = web.Application()
    app.add_routes(routes)
    return app


if __name__ == "__main__":
    port = int(os.getenv("EVALUATOR_PORT", "8090"))
    host = os.getenv("EVALUATOR_HOST", "0.0.0.0")
    logger.info("[Evaluator] starting on %s:%s", host, port)
    web.run_app(make_app(), host=host, port=port, access_log=None)

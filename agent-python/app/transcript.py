"""In-memory + MongoDB transcript recorder for an interview session.

Encapsulates the two LiveKit ``AgentSession`` event handlers used by the
original entrypoint so the runner doesn't need to deal with raw event
objects.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from .time_utils import now_iso


class TranscriptRecorder:
    """Collects user/assistant transcript lines and mirrors them to MongoDB."""

    def __init__(self, db: Any, session_id: str) -> None:
        self._db = db
        self._session_id = session_id
        self.lines: list[dict] = []
        self._listeners: list[Callable[[dict], None]] = []

    # -- registration ------------------------------------------------------

    def attach(self, session: Any) -> None:
        """Register listeners on a LiveKit ``AgentSession``."""
        session.on("user_input_transcribed", self._on_user_transcribed)
        session.on("conversation_item_added", self._on_conversation_item)

    def add_listener(self, listener: Callable[[dict], None]) -> None:
        """Subscribe to stored transcript lines."""
        self._listeners.append(listener)

    # -- handlers ----------------------------------------------------------

    def _on_user_transcribed(self, ev: Any) -> None:
        line = {
            "role": "user",
            "text": getattr(ev, "transcript", "") or "",
            "is_final": bool(getattr(ev, "is_final", False)),
            "created_at": now_iso(),
        }
        if not line["text"].strip():
            return
        self._store(line)

    def _on_conversation_item(self, ev: Any) -> None:
        item = getattr(ev, "item", None) or {}
        role = getattr(item, "role", "") or ""
        if role not in ("assistant", "agent"):
            return
        text = getattr(item, "text_content", "") or getattr(item, "text", "") or ""
        if not text.strip():
            return
        self._store({
            "role": "assistant",
            "text": text,
            "is_final": True,
            "created_at": now_iso(),
        })

    # -- internal ----------------------------------------------------------

    def _store(self, line: dict) -> None:
        self.lines.append(line)
        self._db.interview_events.insert_one({
            "id": str(uuid4()),
            "session_id": self._session_id,
            "type": "transcript",
            "payload": line,
            "created_at": line["created_at"],
        })
        for listener in list(self._listeners):
            listener(line)


__all__ = ["TranscriptRecorder"]

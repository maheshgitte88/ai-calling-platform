"""Tiny time helpers shared by the agent."""

from __future__ import annotations

from datetime import datetime


def now_iso() -> str:
    """Return current UTC time as an ISO-8601 string with a ``Z`` suffix."""
    return datetime.utcnow().isoformat() + "Z"


__all__ = ["now_iso"]

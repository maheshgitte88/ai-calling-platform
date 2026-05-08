"""Dispatch metadata parsing and interview-duration math."""

from __future__ import annotations

import json
from dataclasses import dataclass

# Hard caps copied verbatim from the original entrypoint to preserve behaviour.
_DEFAULT_DURATION_MINUTES = 35
_MIN_DURATION_SECONDS = 60
_MAX_DURATION_SECONDS = 180 * 60
_MIN_CONCLUDE_BUFFER_SECONDS = 45
_MAX_CONCLUDE_BUFFER_SECONDS = 120
_MIN_DRIVE_SECONDS = 30


def parse_metadata(raw: str | None) -> dict:
    """Best-effort JSON parse of dispatch metadata; returns ``{}`` on failure."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


@dataclass(frozen=True)
class InterviewDurations:
    """Time budget for a single interview run, in seconds."""

    total_seconds: int
    conclude_buffer_seconds: int
    drive_seconds: int


def compute_durations(interview_meta: dict) -> InterviewDurations:
    """Derive interview timing from ``interviewMeta.durationMinutes``.

    Mirrors the original calculation: the total duration is clamped between
    1 minute and 3 hours; the wrap-up buffer is between 45 s and 120 s
    (≈ 12.5 % of the total); the active "drive" window fills the rest.
    """
    duration_minutes = int(interview_meta.get("durationMinutes") or _DEFAULT_DURATION_MINUTES)
    total = max(_MIN_DURATION_SECONDS, min(_MAX_DURATION_SECONDS, duration_minutes * 60))
    conclude_buffer = min(_MAX_CONCLUDE_BUFFER_SECONDS, max(_MIN_CONCLUDE_BUFFER_SECONDS, total // 8))
    drive = max(_MIN_DRIVE_SECONDS, total - conclude_buffer)
    return InterviewDurations(
        total_seconds=total,
        conclude_buffer_seconds=conclude_buffer,
        drive_seconds=drive,
    )


__all__ = ["parse_metadata", "InterviewDurations", "compute_durations"]

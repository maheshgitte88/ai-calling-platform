"""Centralised logging configuration for the interview agent."""

from __future__ import annotations

import logging

_NOISY_LOGGERS_WARNING = ("pymongo", "urllib3", "asyncio")
_LIVEKIT_LOGGERS_INFO = ("livekit.agents", "livekit")


def configure_logging() -> None:
    """Tune third-party logger verbosity.

    Mirrors the original module-level setup from ``interview_agent_entrypoint.py``
    so emitted log records stay identical.
    """
    for name in _NOISY_LOGGERS_WARNING:
        logging.getLogger(name).setLevel(logging.WARNING)
    for name in _LIVEKIT_LOGGERS_INFO:
        logging.getLogger(name).setLevel(logging.INFO)


__all__ = ["configure_logging"]

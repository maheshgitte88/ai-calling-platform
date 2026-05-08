"""Optional virtual-avatar (Simli) attachment for an :class:`AgentSession`.

The Simli plugin is imported lazily so the rest of the agent keeps working
even when the package isn't installed in the runtime environment.
"""

from __future__ import annotations

import logging
from typing import Any

from .config import AvatarSettings

logger = logging.getLogger(__name__)

try:
    from livekit.plugins import simli  # type: ignore
except Exception:  # pragma: no cover - plugin is optional
    simli = None  # type: ignore[assignment]


async def maybe_attach_avatar(
    *,
    session: Any,
    ctx: Any,
    room_options: Any,
    avatar: AvatarSettings,
) -> bool:
    """Start a Simli avatar worker when configured.

    Returns ``True`` when an avatar worker was actually started — in that
    case ``room_options.audio_output`` is also set to ``False`` so the
    agent's audio is routed through the avatar (per LiveKit docs).
    """
    if not (avatar.enabled and avatar.provider == "simli"):
        return False

    if simli is None:
        logger.warning(
            "[Avatar] ENABLE_AVATAR=true but simli plugin not installed, continuing voice-only"
        )
        return False

    if not (avatar.simli_api_key and avatar.simli_face_id):
        logger.warning(
            "[Avatar] Missing SIMLI_API_KEY/SIMLI_FACE_ID, continuing voice-only"
        )
        return False

    cfg = simli.SimliConfig(api_key=avatar.simli_api_key, face_id=avatar.simli_face_id)
    if avatar.simli_emotion_id:
        cfg.emotion_id = avatar.simli_emotion_id

    avatar_session = simli.AvatarSession(simli_config=cfg)
    await avatar_session.start(session, room=ctx.room)
    # Per LiveKit avatar docs: route audio via avatar worker, not directly from session.
    room_options.audio_output = False
    return True


__all__ = ["maybe_attach_avatar"]

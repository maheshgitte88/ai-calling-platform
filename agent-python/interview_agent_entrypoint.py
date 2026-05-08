"""LiveKit Video Interview Agent — worker entrypoint.

This file is intentionally tiny: it only wires logging, settings and the
``app.runner`` entrypoint into LiveKit's worker CLI. Everything else lives
in the :mod:`app` package, which is organised so each concern (config,
prompt, providers, transcript, avatar, evaluation, orchestration) lives
in its own focused module.

Common commands:

    python interview_agent_entrypoint.py dev            # local development worker
    python interview_agent_entrypoint.py download-files # warm plugin model caches
    python interview_agent_entrypoint.py start          # production worker
"""

from livekit.agents import WorkerOptions, cli

from app.config import settings
from app.logging_setup import configure_logging
from app.runner import entrypoint

configure_logging()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(agent_name=settings.agent_name, entrypoint_fnc=entrypoint))

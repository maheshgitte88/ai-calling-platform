"""Helpers for compacting long interview chat context."""

from __future__ import annotations

from dataclasses import dataclass

from livekit.agents import ChatContext


DEFAULT_MAX_TAIL_ITEMS = 12
DEFAULT_SUMMARY_TAIL_LINES = 6
DEFAULT_REFRESH_INTERVAL_LINES = 4
MAX_SNIPPET_CHARS = 180
MAX_SUMMARY_SNIPPETS = 3


def _clean_snippet(text: str) -> str:
    snippet = " ".join((text or "").strip().split())
    if len(snippet) <= MAX_SNIPPET_CHARS:
        return snippet
    return snippet[: MAX_SNIPPET_CHARS - 3].rstrip() + "..."


def _final_transcript_lines(transcript_lines: list[dict]) -> list[dict]:
    return [
        line for line in transcript_lines
        if bool(line.get("is_final")) and str(line.get("text") or "").strip()
    ]


def _summarize_transcript_slice(lines: list[dict]) -> str:
    if not lines:
        return ""

    assistant_lines = [
        _clean_snippet(str(line.get("text") or ""))
        for line in lines
        if line.get("role") == "assistant"
    ]
    user_lines = [
        _clean_snippet(str(line.get("text") or ""))
        for line in lines
        if line.get("role") == "user"
    ]

    parts: list[str] = []
    if assistant_lines:
        parts.append(
            "Earlier interviewer topics: " + "; ".join(assistant_lines[-MAX_SUMMARY_SNIPPETS:])
        )
    if user_lines:
        parts.append(
            "Earlier candidate replies: " + "; ".join(user_lines[-MAX_SUMMARY_SNIPPETS:])
        )
    return "\n".join(parts)


@dataclass(slots=True)
class InterviewMemoryState:
    """Compact memory derived from the durable transcript."""

    max_tail_items: int = DEFAULT_MAX_TAIL_ITEMS
    summary_tail_lines: int = DEFAULT_SUMMARY_TAIL_LINES
    refresh_interval_lines: int = DEFAULT_REFRESH_INTERVAL_LINES
    summarized_line_count: int = 0
    summary_text: str = ""

    def refresh_from_transcript(
        self,
        transcript_lines: list[dict],
        *,
        force: bool = False,
    ) -> str:
        final_lines = _final_transcript_lines(transcript_lines)
        older_lines = final_lines[:-self.summary_tail_lines] if len(final_lines) > self.summary_tail_lines else []
        older_count = len(older_lines)

        if not force and older_count == self.summarized_line_count:
            return self.summary_text
        if (
            not force
            and self.summary_text
            and older_count < self.summarized_line_count + self.refresh_interval_lines
        ):
            return self.summary_text

        self.summary_text = _summarize_transcript_slice(older_lines)
        self.summarized_line_count = older_count
        return self.summary_text


def build_compact_chat_context(
    *,
    source_ctx: ChatContext,
    base_instructions: str,
    memory_message: str | None,
    runtime_control: str | None,
    max_tail_items: int = DEFAULT_MAX_TAIL_ITEMS,
) -> ChatContext:
    """Return a bounded chat context with static instructions plus a short tail."""
    tail_ctx = source_ctx.copy(
        exclude_instructions=True,
        exclude_handoff=True,
        exclude_config_update=True,
    )
    if max_tail_items > 0 and len(tail_ctx.items) > max_tail_items:
        tail_ctx.truncate(max_items=max_tail_items)

    compact_ctx = ChatContext()
    compact_ctx.add_message(role="system", content=base_instructions)
    if memory_message:
        compact_ctx.add_message(role="system", content=memory_message)
    if runtime_control:
        compact_ctx.add_message(role="system", content=runtime_control)
    compact_ctx.items.extend(tail_ctx.items)
    return compact_ctx
__all__ = [
    "DEFAULT_MAX_TAIL_ITEMS",
    "InterviewMemoryState",
    "build_compact_chat_context",
]

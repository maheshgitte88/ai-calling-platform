"""Skill-specification normalization for the interview prompt."""

from __future__ import annotations

import re

ALLOWED_DIFFICULTIES = {"easy", "medium", "hard"}
SKILL_KEY_ALIASES = {
    "react": "react",
    "reactjs": "react",
    "node": "nodejs",
    "nodejs": "nodejs",
    "express": "express",
    "expressjs": "express",
    "next": "nextjs",
    "nextjs": "nextjs",
    "vue": "vue",
    "vuejs": "vue",
    "angular": "angular",
    "angularjs": "angular",
}


def canonical_skill_key(raw_skill: str) -> str:
    """Canonicalize skill names so common aliases map to the same key.

    Examples:
    - ``React`` / ``React.js`` -> ``react``
    - ``Node`` / ``Node.js`` -> ``nodejs``
    """
    compact = re.sub(r"[^a-z0-9]+", "", str(raw_skill or "").strip().lower())
    if not compact:
        return ""
    return SKILL_KEY_ALIASES.get(compact, compact)


def normalize_skill_specs(skill_specs: list[dict]) -> list[dict]:
    """Coerce raw skill entries into the canonical interview skill plan shape.

    Output shape (per entry):
      ``{skill, topics, weightage, difficulty, instructions}``

    Field semantics:
    - ``skill``: trimmed string, falls back to ``name``; entries without one are dropped.
    - ``topics``: list of trimmed non-empty strings (only kept when input is a list).
    - ``weightage``: float clamped to ``[0, 100]`` or ``None`` when unparseable.
    - ``difficulty``: one of ``easy|medium|hard`` or ``None`` when missing/unknown.
    - ``instructions``: trimmed free-text guidance for this skill, or ``""``.
    """
    cleaned: list[dict] = []
    for raw in skill_specs:
        # Accept bare strings as a legacy/fallback shape (just the skill name).
        if isinstance(raw, str):
            name = raw.strip()
            if not name:
                continue
            cleaned.append({
                "skill": name,
                "topics": [],
                "weightage": None,
                "difficulty": None,
                "instructions": "",
            })
            continue

        if not isinstance(raw, dict):
            continue

        name = str(raw.get("skill") or raw.get("name") or "").strip()
        if not name:
            continue

        topics_raw = raw.get("topics") or []
        topics = (
            [str(t).strip() for t in topics_raw if str(t).strip()]
            if isinstance(topics_raw, list)
            else []
        )

        weight_val: float | None = None
        weight_raw = raw.get("weightage")
        if isinstance(weight_raw, (int, float)):
            weight_val = float(weight_raw)
        elif isinstance(weight_raw, str):
            try:
                weight_val = float(weight_raw.strip().replace("%", ""))
            except ValueError:
                weight_val = None
        if weight_val is not None:
            weight_val = max(0.0, min(100.0, weight_val))

        difficulty_raw = raw.get("difficulty")
        difficulty: str | None = None
        if isinstance(difficulty_raw, str):
            candidate = difficulty_raw.strip().lower()
            if candidate in ALLOWED_DIFFICULTIES:
                difficulty = candidate

        instructions_raw = raw.get("instructions")
        instructions = str(instructions_raw).strip() if isinstance(instructions_raw, str) else ""

        cleaned.append({
            "skill": name,
            "topics": topics,
            "weightage": weight_val,
            "difficulty": difficulty,
            "instructions": instructions,
        })
    return cleaned


__all__ = ["ALLOWED_DIFFICULTIES", "SKILL_KEY_ALIASES", "canonical_skill_key", "normalize_skill_specs"]

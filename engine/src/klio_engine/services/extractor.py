"""Fact extraction with three-tier fallback.

Picks one backend per call, in priority order:

  1. **Anthropic / cloud LLM** if `KLIO_EXTRACTION_MODEL` is set to a real
     model name (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-6',
     'gpt-4o-mini') AND the relevant API key is present in the
     environment. Best quality.
  2. **Ollama** if `KLIO_EXTRACTION_MODEL` starts with 'ollama/'. Local,
     no API key, decent quality. The container must be running and the
     model must already be pulled. Default: 'ollama/qwen2.5:7b-instruct'.
  3. **Regex stub** if `KLIO_EXTRACTION_MODEL` is 'stub' (or anything
     that fails to dispatch). Deterministic, dependency-free, used in
     tests and as a safety net when nothing else works.

Each tier emits the same `list[ExtractedEntry]` shape so callers don't
care which backend ran.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

import structlog


VALID_KINDS = {"memory", "observation", "plan", "decision", "note"}

logger = structlog.get_logger(__name__)


@dataclass
class ExtractedEntry:
    kind: str
    content: str
    confidence: float
    metadata: dict[str, Any] | None = None


_STUB_RULES: list[tuple[str, re.Pattern[str], float]] = [
    (
        "memory",
        re.compile(
            r"(?:user (?:said|stated|prefers?)|i (?:said|use|prefer)|remember that)\s+(?P<fact>[^.\n]{5,400})",
            re.IGNORECASE,
        ),
        0.9,
    ),
    (
        "decision",
        re.compile(
            r"(?:decided|chosen|going with|we'll use)\s+(?P<fact>[^.\n]{5,400})",
            re.IGNORECASE,
        ),
        0.85,
    ),
    (
        "plan",
        re.compile(
            r"(?:plan(?:ning)?|will|next step|step \d)\s*(?:to|:)?\s*(?P<fact>[^.\n]{5,400})",
            re.IGNORECASE,
        ),
        0.7,
    ),
]

EXTRACT_PROMPT = """\
You extract structured facts from agent-user conversations.

Output ONLY valid JSON in this shape:
{"entries": [{"kind": ..., "content": ..., "confidence": ...}, ...]}

Allowed kinds (NOTHING ELSE):
- memory: a stable fact about the user, project, or context
- observation: something an agent did or saw during the conversation
- plan: forward-looking intent
- decision: a chosen path with rationale
- note: free-form annotation

Rules:
- Confidence is 0.0-1.0. Use 0.9+ only when explicitly stated by the user.
- Do NOT include speculative or low-information items.
- Keep each content under 500 characters.
- If nothing is extractable, return {"entries": []}.

Conversation:
---
{transcript}
---
"""


class FactExtractor:
    """Pick a backend at construct time, fall back to stub on errors."""

    def __init__(self, *, model: str | None = None) -> None:
        self._model = (model or os.getenv("KLIO_EXTRACTION_MODEL", "stub")).strip()

    @property
    def backend(self) -> str:
        if self._model == "stub":
            return "stub"
        if self._model.startswith("ollama/"):
            return "ollama"
        return "cloud"

    async def extract(self, transcript: str) -> list[ExtractedEntry]:
        backend = self.backend
        if backend == "stub":
            return self._stub_extract(transcript)
        if backend == "ollama":
            try:
                return await self._ollama_extract(transcript)
            except Exception as e:
                logger.warning(
                    "extractor.ollama_failed_falling_back",
                    error=str(e),
                    model=self._model,
                )
                return self._stub_extract(transcript)
        try:
            return await self._cloud_extract(transcript)
        except Exception as e:
            logger.warning(
                "extractor.cloud_failed_falling_back",
                error=str(e),
                model=self._model,
            )
            return self._stub_extract(transcript)

    @staticmethod
    def _stub_extract(transcript: str) -> list[ExtractedEntry]:
        seen: set[str] = set()
        out: list[ExtractedEntry] = []
        for kind, pattern, conf in _STUB_RULES:
            for match in pattern.finditer(transcript):
                fact = match.group("fact").strip().rstrip(",.")
                if not fact or fact in seen:
                    continue
                seen.add(fact)
                out.append(
                    ExtractedEntry(kind=kind, content=fact[:500], confidence=conf)
                )
        return out

    async def _ollama_extract(self, transcript: str) -> list[ExtractedEntry]:
        """Call Ollama's chat endpoint directly. Tested with qwen2.5:7b-instruct
        and llama3.1:8b-instruct; both follow JSON-only output reliably at
        temperature=0.1."""
        import httpx

        from klio_engine.config import Settings

        base = os.getenv(
            "KLIO_OLLAMA_API_BASE", Settings().ollama_api_base
        ).rstrip("/")
        model = self._model.split("/", 1)[1]
        prompt = EXTRACT_PROMPT.format(transcript=transcript[:50_000])
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(
                f"{base}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "options": {"temperature": 0.1, "num_predict": 2000},
                    "format": "json",
                },
            )
            r.raise_for_status()
            content = r.json()["message"]["content"]
        return self._parse_llm_json(content)

    async def _cloud_extract(self, transcript: str) -> list[ExtractedEntry]:
        """Call a hosted LLM via LiteLLM (Anthropic, OpenAI, etc.)."""
        from litellm import acompletion

        prompt = EXTRACT_PROMPT.format(transcript=transcript[:50_000])
        response = await acompletion(
            model=self._model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=2_000,
        )
        content = response["choices"][0]["message"]["content"]
        return self._parse_llm_json(content)

    @staticmethod
    def _parse_llm_json(raw: str) -> list[ExtractedEntry]:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match is None:
            return []
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            logger.warning("extractor.json_decode_failed", raw_head=raw[:200])
            return []
        out: list[ExtractedEntry] = []
        for item in payload.get("entries", []):
            kind = item.get("kind")
            content = (item.get("content") or "").strip()
            try:
                confidence = float(item.get("confidence", 1.0))
            except (TypeError, ValueError):
                confidence = 1.0
            if kind in VALID_KINDS and content and 0.0 <= confidence <= 1.0:
                out.append(
                    ExtractedEntry(
                        kind=kind, content=content[:500], confidence=confidence
                    )
                )
        return out

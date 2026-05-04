"""Fact extraction with prefix-routed backends and stub fallback.

Picks one backend per call, by `KLIO_EXTRACTION_MODEL` prefix:

  1. **stub** — regex-only deterministic extraction. Used in tests and
     as a safety net when transient backend failures happen.
  2. **ollama/<model>** — local, no API key, decent quality. The
     container must be running and the model must already be pulled.
     Default: 'ollama/qwen2.5:7b-instruct'.
  3. **openrouter/<vendor>/<model>** — direct httpx POST to
     https://openrouter.ai/api/v1/chat/completions with attribution
     headers. Requires KLIO_OPENROUTER_API_KEY.
  4. **custom/<model>** — direct httpx POST to KLIO_CUSTOM_BASE_URL/
     chat/completions. Used by self-hosted LiteLLM proxies, Azure
     OpenAI, vLLM endpoints, etc. Authorization header is sent only
     when KLIO_CUSTOM_API_KEY is set.

Anything else raises ValueError to fail fast — that's a configuration
error, not a transient failure, and silently falling back to stub
would mask the misconfiguration.

Each tier emits the same `list[ExtractedEntry]` shape so callers don't
care which backend ran. Transient errors at runtime (network blips,
LLM JSON malformed, etc.) fall back to the regex stub so the write
path never 500s on extraction noise.
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


_OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
_ATTRIBUTION_HEADERS = {
    "HTTP-Referer": "https://klio.tech",
    "X-Title": "Klio",
}


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

# `str.format` placeholders use `{name}` syntax, so JSON literal braces
# in the prompt body must be doubled. This used to silently raise
# `KeyError('"entries"')` inside the cloud-tier try/except and fall
# back to stub on every cloud call — which is why bare-OpenAI-cloud
# extraction never seemed to work in 0.2.x.
EXTRACT_PROMPT = """\
You extract structured facts from agent-user conversations.

Output ONLY valid JSON in this shape:
{{"entries": [{{"kind": ..., "content": ..., "confidence": ...}}, ...]}}

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
- If nothing is extractable, return {{"entries": []}}.

Conversation:
---
{transcript}
---
"""


class FactExtractor:
    """Pick a backend by prefix, fall back to stub on transient errors.

    Configuration errors (unknown prefix, missing required env var)
    raise ValueError so the operator sees the problem instead of
    silently extracting nothing useful via the regex stub."""

    def __init__(self, *, model: str | None = None) -> None:
        self._model = (model or os.getenv("KLIO_EXTRACTION_MODEL", "stub")).strip()

    @property
    def backend(self) -> str:
        """Map the configured model name to a backend tag.

        Raises ValueError when the prefix isn't supported — that's a
        config error, not a runtime fault."""
        if self._model == "stub":
            return "stub"
        if self._model.startswith("ollama/"):
            return "ollama"
        if self._model.startswith("openrouter/"):
            return "openrouter"
        if self._model.startswith("custom/"):
            return "custom"
        raise ValueError(
            f"unsupported model {self._model!r}: name must start with "
            f"ollama/, openrouter/, custom/, or be 'stub'"
        )

    async def extract(self, transcript: str) -> list[ExtractedEntry]:
        # `backend` raises ValueError on unsupported prefixes so the
        # operator sees a config error before we enter the try/except
        # below — otherwise the fallback would silently swallow it.
        backend = self.backend
        if backend == "stub":
            return self._stub_extract(transcript)
        try:
            if backend == "ollama":
                return await self._ollama_extract(transcript)
            if backend == "openrouter":
                return await self._openrouter_extract(transcript)
            if backend == "custom":
                return await self._custom_extract(transcript)
        except Exception as e:
            logger.warning(
                "extractor.backend_failed_falling_back",
                error=str(e),
                backend=backend,
                model=self._model,
            )
            return self._stub_extract(transcript)
        # Defence-in-depth: backend validated above, this is unreachable.
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

    async def _openrouter_extract(
        self, transcript: str
    ) -> list[ExtractedEntry]:
        """Call OpenRouter's OpenAI-compatible /chat/completions endpoint.

        Strips the `openrouter/` prefix (OpenRouter expects the bare
        `<vendor>/<model>` form) and sends Klio's attribution headers
        so usage shows up correctly on the OpenRouter dashboard."""
        import httpx

        from klio_engine.config import Settings

        s = Settings()
        api_key = s.openrouter_api_key
        if not api_key:
            raise ValueError(
                "openrouter/* model requested but KLIO_OPENROUTER_API_KEY "
                "is not set."
            )
        model = self._model.split("/", 1)[1]
        prompt = EXTRACT_PROMPT.format(transcript=transcript[:50_000])
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            **_ATTRIBUTION_HEADERS,
        }
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(
                _OPENROUTER_CHAT_URL,
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 2_000,
                },
                headers=headers,
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
        return self._parse_llm_json(content)

    async def _custom_extract(
        self, transcript: str
    ) -> list[ExtractedEntry]:
        """Call a user-supplied OpenAI-compatible /chat/completions endpoint.

        Strips the `custom/` prefix so the wire body carries the model
        name the proxy expects. The Authorization header is sent only
        when KLIO_CUSTOM_API_KEY is set — empty key means no header at
        all (some local proxies reject `Authorization: Bearer ` with an
        empty token)."""
        import httpx

        from klio_engine.config import Settings

        s = Settings()
        base = s.custom_base_url
        if not base:
            raise ValueError(
                "custom/* model requested but KLIO_CUSTOM_BASE_URL is "
                "not set."
            )
        model = self._model.split("/", 1)[1]
        prompt = EXTRACT_PROMPT.format(transcript=transcript[:50_000])
        headers = {
            "Content-Type": "application/json",
            **_ATTRIBUTION_HEADERS,
        }
        if s.custom_api_key:
            headers["Authorization"] = f"Bearer {s.custom_api_key}"
        url = f"{base.rstrip('/')}/chat/completions"
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(
                url,
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 2_000,
                },
                headers=headers,
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
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

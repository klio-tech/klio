"""PII scrubbing.

Conservative regex-based redaction. We catch the common high-risk patterns
before any extracted entry is stored: emails, SSNs, credit cards, AWS keys,
phone numbers, generic API keys.
"""
import re

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"), "[EMAIL]"),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[SSN]"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[CARD]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[AWS_KEY]"),
    (re.compile(r"\b(?:sk-|pk_)[A-Za-z0-9]{20,}\b"), "[API_KEY]"),
    (re.compile(r"\+?\d[\d\s().-]{8,15}\d"), "[PHONE]"),
]


def scrub_pii(text: str) -> str:
    """Return text with high-risk PII redacted."""
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out

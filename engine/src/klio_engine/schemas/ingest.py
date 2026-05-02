"""Ingest schemas."""
import uuid
from typing import Any

from pydantic import BaseModel, Field


class TranscriptMessage(BaseModel):
    role: str
    content: str


class IngestTranscriptRequest(BaseModel):
    session_id: uuid.UUID
    source_type: str = "claude-code-session"
    messages: list[TranscriptMessage] = Field(..., min_length=1, max_length=10_000)
    metadata: dict[str, Any] | None = None


class IngestTranscriptResponse(BaseModel):
    session_id: uuid.UUID
    extracted_count: int
    written_entry_ids: list[uuid.UUID]

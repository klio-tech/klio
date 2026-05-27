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

    # v0.7.0 per-project scoping context — populated by the bridge on
    # every transcript ingest that originates from a hook fire with a
    # resolvable cwd. All four fields are OPTIONAL: ad-hoc chats with no
    # working directory (e.g. an MCP client invoked outside a repo) still
    # ingest fine, just without project tagging. The Session row's `cwd`
    # column is populated directly; the project context fields are passed
    # through `ProjectService.ensure` to get-or-create the project row
    # and tag every extracted Entry with its `project_id`.
    #
    # Length bounds match conservative real-world limits:
    #   - paths ≤ 4096 covers POSIX `PATH_MAX`
    #   - URLs ≤ 2048 matches common HTTP header / SSH URL bounds
    #   - display names ≤ 200 mirrors `projects.display_name`'s String(200)
    cwd: str | None = Field(default=None, max_length=4096)
    # `git_remote`, `repo_root_path`, and `project_display_name` reject
    # empty strings as 422. A bridge sending `git_remote=""` (e.g.
    # `git config --get remote.origin.url` returned blank instead of
    # erroring) would otherwise bypass the
    # `if body.git_remote or body.repo_root_path` gate via the other
    # truthy field and corrupt project dedup: the `_find` query matches
    # `git_remote == ""`, finds nothing, then INSERT creates a row with
    # `git_remote=""` that the partial unique index treats as its own
    # slot — a subsequent ingest with `git_remote=None` dedupes against
    # the path-only index and lands on a DIFFERENT row, splitting
    # memory across two phantom projects for what should be one. Empty
    # strings here almost always indicate a bridge bug; surfacing them
    # as a clear 422 beats silent project-row corruption.
    #
    # `cwd` stays unbounded on min_length — an empty cwd is meaningfully
    # different from a missing one (e.g. a hook fired from the shell's
    # home with no specific working dir).
    git_remote: str | None = Field(default=None, min_length=1, max_length=2048)
    repo_root_path: str | None = Field(default=None, min_length=1, max_length=4096)
    project_display_name: str | None = Field(default=None, min_length=1, max_length=200)


class IngestTranscriptResponse(BaseModel):
    session_id: uuid.UUID
    extracted_count: int
    written_entry_ids: list[uuid.UUID]

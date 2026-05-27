"""RecallService project_id filter — v0.7.0 per-project memory scoping.

These tests cover the SQL clause added in B2:

    AND (e.project_id = :project_id OR e.project_id IS NULL)

Two non-obvious invariants the tests defend:

  1. NULL-tagged entries surface in EVERY project's recall. This is the
     load-bearing safe default for legacy rows (written before per-
     project scoping landed in v0.7.0) and for rows written from
     non-detectable contexts (bridge fired a hook from a non-git,
     non-repo folder). Dropping the `IS NULL` branch would silently
     hide all pre-0.7 memory from recall the moment the bridge starts
     passing project_id.

  2. project_id=None must return ALL entries in the space regardless
     of their tag — the v0.6 behaviour. This is the cross-project
     recall escape hatch that B3 exposes via the API.

Test setup mirrors `test_reembed.py` / `test_recall_ollama.py` but
runs hermetically against the conftest `session + mock_kms` fixtures
with the stub embedding model (deterministic, no Ollama needed).

Why we mutate `Entry.project_id` post-write instead of passing it as a
kwarg to EntryService.write: tagging at write-time lands in task C1,
not B2. The recall filter ships first so the API contract (B3) and
the bridge tagging (E2) can land independently against a stable
engine method. Setting the FK column directly through the ORM and
flushing is the canonical pattern for "field added in the same
migration that this test exercises but the write path hasn't been
updated yet" — the same shape used by other partial-rollout tests
in this repo.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.projects import ProjectService
from klio_engine.services.provisioning import provision_user
from klio_engine.services.recall import RecallService


# --- Hermetic env ---------------------------------------------------
#
# `provision_user` constructs a Settings (pydantic-settings) instance,
# which requires `KLIO_DATABASE_URL` and reads `KLIO_EMBEDDING_MODEL`
# / `KLIO_EXTRACTION_MODEL` to wire EmbeddingService + extractor
# routing inside EntryService. Without ambient env, Settings() would
# either fail validation (database_url Field required) or default
# `embedding_model` to `ollama/nomic-embed-text` and try to talk to a
# live Ollama daemon — making this test file's "stub-model, no
# external services" claim depend on the developer's shell.
#
# Pin the env vars deterministically per-test so the suite runs under
# bare `pytest tests/services/test_recall.py` with no shell setup.
# `monkeypatch.setenv` auto-restores at teardown so neighbouring
# test files see their own env. Matches the pattern in
# `tests/test_curator_writer.py`.


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Auto-applied to every test in this file. `provision_user`
    instantiates Settings() which requires KLIO_DATABASE_URL and reads
    KLIO_EMBEDDING_MODEL / KLIO_EXTRACTION_MODEL. Set all three to
    predictable hermetic values so the suite runs under bare `pytest`
    without ambient env. The DB url here is only used to satisfy
    Settings validation — actual session connections go through
    conftest's `session` fixture which reads KLIO_TEST_DATABASE_URL
    directly."""
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")


async def _setup_user_and_services(
    session: AsyncSession, kms: KMSClient
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID, EntryService, RecallService]:
    """Provision a user + agent + default space, return ids and services.

    Returns: (user_id, agent_id, space_id, entry_svc, recall_svc).

    Uses `provision_user` rather than the inline `_make_user_agent_space`
    helper from `test_acl.py` because entries are encrypted and need a
    real envelope key on the user row — `provision_user` is the only
    code path that materialises one in production, so reproducing it
    inline would diverge from how entries are actually written.
    """
    provisioned = await provision_user(
        session,
        kms=kms,
        agent_kind="claude-code",
        install_id=uuid.uuid4(),
    )
    await session.flush()
    embed_svc = EmbeddingService()
    entry_svc = EntryService(kms=kms, embeddings=embed_svc)
    recall_svc = RecallService(embeddings=embed_svc)
    return (
        provisioned.user_id,
        provisioned.agent_id,
        provisioned.default_space_id,
        entry_svc,
        recall_svc,
    )


async def _write_tagged_entry(
    session: AsyncSession,
    entry_svc: EntryService,
    *,
    user_id: uuid.UUID,
    space_id: uuid.UUID,
    agent_id: uuid.UUID,
    content: str,
    project_id: uuid.UUID | None,
) -> Entry:
    """Write an entry via EntryService, then tag it with `project_id`.

    The write path doesn't yet accept project_id (task C1); we mutate
    the FK column post-flush. Returns the persisted Entry."""
    e = await entry_svc.write(
        session,
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        kind=EntryKind.MEMORY,
        content=content,
    )
    e.project_id = project_id
    await session.flush()
    return e


@pytest.mark.asyncio
async def test_recall_filters_to_project_id(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    """When project_id is set, only entries tagged with THAT project
    (plus NULL-tagged entries) are eligible. Entries tagged for a
    different project must not appear in results."""
    user_id, agent_id, space_id, entry_svc, recall_svc = (
        await _setup_user_and_services(session, mock_kms)
    )
    project_svc = ProjectService()
    proj_a = await project_svc.ensure(
        session,
        user_id=user_id,
        git_remote="git@github.com:klio-tech/repo-a.git",
        repo_root_path="/Users/x/repo-a",
        display_name="repo-a",
    )
    proj_b = await project_svc.ensure(
        session,
        user_id=user_id,
        git_remote="git@github.com:klio-tech/repo-b.git",
        repo_root_path="/Users/x/repo-b",
        display_name="repo-b",
    )
    await session.flush()

    entry_a = await _write_tagged_entry(
        session,
        entry_svc,
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        content="repo-a uses Bun runtime for JavaScript",
        project_id=proj_a.id,
    )
    entry_b = await _write_tagged_entry(
        session,
        entry_svc,
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        content="repo-b uses Deno runtime for TypeScript",
        project_id=proj_b.id,
    )

    results = await recall_svc.recall(
        session,
        user_id=user_id,
        space_id=space_id,
        query="which runtime is used",
        project_id=proj_a.id,
        limit=10,
    )

    result_ids = {entry.id for entry, _ in results}
    assert entry_a.id in result_ids, (
        f"project A's entry must surface under project_id={proj_a.id}"
    )
    assert entry_b.id not in result_ids, (
        f"project B's entry must NOT surface under project_id={proj_a.id}; "
        f"got ids={result_ids}"
    )


@pytest.mark.asyncio
async def test_recall_null_project_entries_surface_with_project_filter(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    """Legacy/uncategorized entries (project_id IS NULL) must appear in
    every project's recall. This is the migration-safety guarantee that
    lets v0.7.0 ship without re-tagging existing v0.6 entries.

    Without the `OR project_id IS NULL` branch, every pre-0.7 memory
    would silently disappear from recall the moment the bridge starts
    passing a project filter — a far worse user-visible regression than
    the small risk of cross-project bleed from untagged rows."""
    user_id, agent_id, space_id, entry_svc, recall_svc = (
        await _setup_user_and_services(session, mock_kms)
    )
    project_svc = ProjectService()
    proj_a = await project_svc.ensure(
        session,
        user_id=user_id,
        git_remote="git@github.com:klio-tech/repo-a.git",
        repo_root_path="/Users/x/repo-a",
        display_name="repo-a",
    )
    await session.flush()

    tagged = await _write_tagged_entry(
        session,
        entry_svc,
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        content="repo-a uses Bun runtime",
        project_id=proj_a.id,
    )
    legacy = await _write_tagged_entry(
        session,
        entry_svc,
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        content="user generally prefers fast cold starts",
        project_id=None,
    )

    results = await recall_svc.recall(
        session,
        user_id=user_id,
        space_id=space_id,
        query="runtime preference",
        project_id=proj_a.id,
        limit=10,
    )

    result_ids = {entry.id for entry, _ in results}
    assert tagged.id in result_ids, "project-A entry must surface"
    assert legacy.id in result_ids, (
        "NULL-tagged entry must also surface — load-bearing safe "
        f"default for legacy/uncategorized rows; got ids={result_ids}"
    )


@pytest.mark.asyncio
async def test_recall_no_project_id_returns_all(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    """When project_id is omitted (default None), recall returns all
    entries in the space regardless of project tag. This is the v0.6
    behaviour and the cross-project recall escape hatch the API uses
    when the caller explicitly asks for `project=any`."""
    user_id, agent_id, space_id, entry_svc, recall_svc = (
        await _setup_user_and_services(session, mock_kms)
    )
    project_svc = ProjectService()
    proj_a = await project_svc.ensure(
        session,
        user_id=user_id,
        git_remote="git@github.com:klio-tech/repo-a.git",
        repo_root_path="/Users/x/repo-a",
        display_name="repo-a",
    )
    proj_b = await project_svc.ensure(
        session,
        user_id=user_id,
        git_remote="git@github.com:klio-tech/repo-b.git",
        repo_root_path="/Users/x/repo-b",
        display_name="repo-b",
    )
    await session.flush()

    entry_a = await _write_tagged_entry(
        session,
        entry_svc,
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        content="repo-a uses Bun runtime",
        project_id=proj_a.id,
    )
    entry_b = await _write_tagged_entry(
        session,
        entry_svc,
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        content="repo-b uses Deno runtime",
        project_id=proj_b.id,
    )

    results = await recall_svc.recall(
        session,
        user_id=user_id,
        space_id=space_id,
        query="runtime",
        limit=10,
    )

    result_ids = {entry.id for entry, _ in results}
    assert entry_a.id in result_ids
    assert entry_b.id in result_ids, (
        "project_id=None must NOT filter by tag; both projects' "
        f"entries must surface. Got ids={result_ids}"
    )

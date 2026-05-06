"""curator_state — per-user cursor for the background curator.

The curator (v0.5.0) reads kind=observation entries since this
cursor's `last_cursor_at` and synthesises memory/decision/plan/note
entries from them. The cursor advances only on a successful batch
commit. See docs/plans/2026-05-06-klio-curator-design.md.

Per-user lazy creation: this migration creates the table empty.
The first tick for each user inserts that user's row; we don't
backfill rows for existing users because the default
`last_cursor_at = '1970-01-01'` already produces correct behaviour
on the first read (process every observation the user owns).

Revision ID: 0006
Revises: 0005
"""
from collections.abc import Sequence
from typing import Union

from alembic import op


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Raw SQL matches the project convention established in 0001-0005.
    # Column shape mirrors `klio_engine.models.curator_state.CuratorState`
    # one-for-one: same names, same types, same defaults, same FK.
    op.execute(
        """
        CREATE TABLE curator_state (
            user_id UUID PRIMARY KEY
                REFERENCES users(id) ON DELETE CASCADE,
            last_run_at TIMESTAMPTZ,
            last_cursor_at TIMESTAMPTZ NOT NULL
                DEFAULT '1970-01-01 00:00:00+00'::timestamptz,
            runs_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            last_synthesized INTEGER NOT NULL DEFAULT 0,
            CONSTRAINT runs_count_non_negative CHECK (runs_count >= 0),
            CONSTRAINT last_synthesized_non_negative CHECK (last_synthesized >= 0)
        )
        """
    )
    # Match the SQLAlchemy model: `last_cursor_at` carries `index=True`
    # so future fan-out queries (e.g. "users behind by > N minutes")
    # don't sequentially scan the table. Cheap on a per-user-single-row
    # table, asymmetric upside if such a query is ever added.
    op.execute(
        "CREATE INDEX ix_curator_state_last_cursor_at "
        "ON curator_state (last_cursor_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_curator_state_last_cursor_at")
    op.execute("DROP TABLE IF EXISTS curator_state")

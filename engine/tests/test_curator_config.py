"""Curator config — env-var → Settings round-trip.

Defaults match what the npm CLI writes into `~/.klio/.env`. The
inheritance from `extraction_model` when `curator_model` is blank is
the contract that lets `klio init` ask only one question."""
from __future__ import annotations

import os
from unittest import mock

import pytest

from klio_engine.config import Settings


def test_curator_defaults_when_no_env() -> None:
    with mock.patch.dict(os.environ, {}, clear=True):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.curator_enabled is True
    assert s.curator_interval_secs == 3600
    assert s.curator_batch_size == 50
    assert s.curator_model == ""


def test_curator_disabled_via_env() -> None:
    with mock.patch.dict(os.environ, {"KLIO_CURATOR_ENABLED": "false"}, clear=True):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.curator_enabled is False


def test_curator_interval_via_env() -> None:
    with mock.patch.dict(
        os.environ, {"KLIO_CURATOR_INTERVAL_SECS": "14400"}, clear=True
    ):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.curator_interval_secs == 14400


def test_curator_model_inherits_extraction_model_when_blank() -> None:
    """When KLIO_CURATOR_MODEL is unset / empty, the curator falls back
    to whatever the user picked for extraction. This is the
    one-question-during-init contract."""
    with mock.patch.dict(
        os.environ,
        {
            "KLIO_EXTRACTION_MODEL": "ollama/qwen2.5:7b-instruct",
            "KLIO_CURATOR_MODEL": "",
        },
        clear=True,
    ):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.effective_curator_model == "ollama/qwen2.5:7b-instruct"


def test_curator_model_override_wins() -> None:
    """Power user sets a separate cheaper model for curation."""
    with mock.patch.dict(
        os.environ,
        {
            "KLIO_EXTRACTION_MODEL": "openrouter/openai/gpt-4o",
            "KLIO_CURATOR_MODEL": "openrouter/openai/gpt-4o-mini",
        },
        clear=True,
    ):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.effective_curator_model == "openrouter/openai/gpt-4o-mini"

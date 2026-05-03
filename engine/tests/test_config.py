"""Tests for the engine Settings class.

These tests verify env-var binding for fields on `klio_engine.config.Settings`.
Each test sets `KLIO_DATABASE_URL` because it is a required field on the model;
without it Settings() would fail validation before any optional field is read.
"""
from __future__ import annotations

import importlib

import pytest


def _fresh_settings():
    """Re-import the config module so a new Settings class picks up env state.

    pydantic-settings reads the environment at instantiation, so a plain
    `Settings()` is sufficient — but importing inside the test guarantees no
    stale module-level state from other tests in the suite.
    """
    import klio_engine.config as config_module

    importlib.reload(config_module)
    return config_module.Settings


def test_settings_accepts_openrouter_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KLIO_OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    Settings = _fresh_settings()
    s = Settings()
    assert s.openrouter_api_key == "sk-or-test"


def test_settings_default_openrouter_key_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.delenv("KLIO_OPENROUTER_API_KEY", raising=False)
    Settings = _fresh_settings()
    s = Settings()
    assert s.openrouter_api_key is None

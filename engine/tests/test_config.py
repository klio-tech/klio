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


def test_settings_accepts_custom_endpoint_fields(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "https://litellm.acme.corp/v1")
    monkeypatch.setenv("KLIO_CUSTOM_API_KEY", "sk-test")
    Settings = _fresh_settings()
    s = Settings()
    assert s.custom_base_url == "https://litellm.acme.corp/v1"
    assert s.custom_api_key == "sk-test"


def test_settings_default_custom_fields_are_none(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.delenv("KLIO_CUSTOM_BASE_URL", raising=False)
    monkeypatch.delenv("KLIO_CUSTOM_API_KEY", raising=False)
    Settings = _fresh_settings()
    s = Settings()
    assert s.custom_base_url is None
    assert s.custom_api_key is None

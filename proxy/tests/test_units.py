"""Unit tests for the pieces that are easier to pin down in isolation."""

from __future__ import annotations

import pytest

from klio_proxy.config import ProxyConfig, load_config
from klio_proxy.headers import (
    ensure_no_transparent_decoding,
    forwardable_request_headers,
    forwardable_response_headers,
)
from klio_proxy.seam import apply_request_seam, transform_request_body


class TestHeaders:
    def test_hop_by_hop_request_headers_are_dropped(self) -> None:
        headers = [
            ("host", "localhost:8787"),
            ("connection", "keep-alive"),
            ("transfer-encoding", "chunked"),
            ("content-length", "42"),
            ("x-api-key", "sk-ant-secret"),
            ("anthropic-version", "2023-06-01"),
        ]
        result = dict(forwardable_request_headers(headers))
        assert "host" not in result
        assert "connection" not in result
        assert "transfer-encoding" not in result
        assert "content-length" not in result
        assert result["x-api-key"] == "sk-ant-secret"
        assert result["anthropic-version"] == "2023-06-01"

    def test_unknown_headers_are_forwarded(self) -> None:
        """The filter is a deny list, so tomorrow's header survives today's code."""
        headers = [("anthropic-something-invented-in-2027", "value")]
        assert forwardable_request_headers(headers) == headers

    def test_duplicate_request_headers_are_preserved(self) -> None:
        headers = [("accept", "text/event-stream"), ("accept", "application/json")]
        assert forwardable_request_headers(headers) == headers

    def test_response_keeps_content_length_and_encoding(self) -> None:
        """Both describe a body we forward unchanged, so both stay true."""
        headers = [
            ("content-length", "1234"),
            ("content-encoding", "gzip"),
            ("transfer-encoding", "chunked"),
            ("anthropic-ratelimit-tokens-remaining", "18000"),
        ]
        result = dict(forwardable_response_headers(headers))
        assert result["content-length"] == "1234"
        assert result["content-encoding"] == "gzip"
        assert result["anthropic-ratelimit-tokens-remaining"] == "18000"
        assert "transfer-encoding" not in result

    def test_header_filtering_is_case_insensitive(self) -> None:
        assert forwardable_response_headers([("Transfer-Encoding", "chunked")]) == []
        assert forwardable_request_headers([("HOST", "x")]) == []

    def test_accept_encoding_pinned_only_when_absent(self) -> None:
        assert ("accept-encoding", "identity") in ensure_no_transparent_decoding([])

        clients_own = [("Accept-Encoding", "gzip, br")]
        assert ensure_no_transparent_decoding(clients_own) == clients_own


class TestSeam:
    def test_stage_three_transform_is_identity(self) -> None:
        for body in (b"", b"{}", b"\x00\xff\xfe binary", b"x" * 100_000):
            assert transform_request_body(body, "application/json") == body

    def test_apply_seam_swallows_exceptions(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import klio_proxy.seam as seam_module

        def boom(_b: bytes, _c: str | None) -> bytes:
            raise ValueError("nope")

        monkeypatch.setattr(seam_module, "transform_request_body", boom)
        assert apply_request_seam(b"original", "application/json") == b"original"

    def test_apply_seam_rejects_non_bytes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import klio_proxy.seam as seam_module

        monkeypatch.setattr(seam_module, "transform_request_body", lambda b, c: ["wrong"])
        assert apply_request_seam(b"original", None) == b"original"

    def test_apply_seam_does_not_swallow_keyboard_interrupt(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Swallowing these would make the proxy unkillable."""
        import klio_proxy.seam as seam_module

        def interrupt(_b: bytes, _c: str | None) -> bytes:
            raise KeyboardInterrupt

        monkeypatch.setattr(seam_module, "transform_request_body", interrupt)
        with pytest.raises(KeyboardInterrupt):
            apply_request_seam(b"original", None)


class TestConfig:
    def test_defaults(self) -> None:
        config = load_config({})
        assert config.upstream_base_url == "https://api.anthropic.com"
        assert config.port == 8787
        assert config.host == "127.0.0.1"
        assert config.read_timeout is None, "a finite read timeout truncates long turns"

    def test_env_overrides(self) -> None:
        config = load_config(
            {
                "KLIO_PROXY_UPSTREAM_URL": "http://127.0.0.1:9999/",
                "KLIO_PROXY_PORT": "9100",
                "KLIO_PROXY_HOST": "0.0.0.0",
                "KLIO_PROXY_CONNECT_TIMEOUT": "3.5",
                "KLIO_PROXY_READ_TIMEOUT": "120",
            }
        )
        assert config.upstream_origin == "http://127.0.0.1:9999"
        assert config.port == 9100
        assert config.host == "0.0.0.0"
        assert config.connect_timeout == 3.5
        assert config.read_timeout == 120.0

    def test_read_timeout_none_literal(self) -> None:
        assert load_config({"KLIO_PROXY_READ_TIMEOUT": "none"}).read_timeout is None

    def test_rejects_non_http_upstream(self) -> None:
        with pytest.raises(ValueError, match="KLIO_PROXY_UPSTREAM_URL"):
            ProxyConfig(upstream_base_url="ftp://example.com")

    def test_rejects_bad_port(self) -> None:
        with pytest.raises(ValueError, match="KLIO_PROXY_PORT"):
            ProxyConfig(port=70000)
        with pytest.raises(ValueError, match="must be an integer"):
            load_config({"KLIO_PROXY_PORT": "eight-thousand"})

    def test_upstream_origin_strips_trailing_slash(self) -> None:
        assert ProxyConfig(upstream_base_url="https://api.anthropic.com/").upstream_origin == (
            "https://api.anthropic.com"
        )


class TestUpstreamRouting:
    """Unit-level checks on the prefix split."""

    def _config(self) -> ProxyConfig:
        return ProxyConfig(
            upstream_base_url="https://api.anthropic.com",
            openai_base_url="https://api.openai.com",
        )

    def test_unprefixed_path_uses_default_upstream(self) -> None:
        from klio_proxy.app import _resolve_upstream

        assert _resolve_upstream("/v1/messages", self._config()) == (
            "https://api.anthropic.com",
            "/v1/messages",
        )

    def test_prefix_is_stripped(self) -> None:
        from klio_proxy.app import _resolve_upstream

        assert _resolve_upstream("/__klio/upstream/openai/v1/responses", self._config()) == (
            "https://api.openai.com",
            "/v1/responses",
        )

    def test_bare_prefix_forwards_root(self) -> None:
        from klio_proxy.app import _resolve_upstream

        assert _resolve_upstream("/__klio/upstream/openai", self._config()) == (
            "https://api.openai.com",
            "/",
        )

    def test_a_path_that_merely_mentions_the_prefix_is_not_routed(self) -> None:
        """Only a LEADING prefix routes; the string appearing later does not."""
        from klio_proxy.app import _resolve_upstream

        path = "/v1/messages/__klio/upstream/openai"
        assert _resolve_upstream(path, self._config()) == ("https://api.anthropic.com", path)

    def test_unknown_name_raises_rather_than_defaulting(self) -> None:
        from klio_proxy.app import UnknownUpstreamError, _resolve_upstream

        with pytest.raises(UnknownUpstreamError) as excinfo:
            _resolve_upstream("/__klio/upstream/gemini/v1/x", self._config())
        assert excinfo.value.name == "gemini"

    def test_openai_upstream_url_is_validated(self) -> None:
        with pytest.raises(ValueError, match="KLIO_PROXY_OPENAI_URL"):
            ProxyConfig(openai_base_url="localhost:1234")

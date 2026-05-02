"""Smoke tests: package imports + version is set."""
import klio_engine


def test_package_imports() -> None:
    assert klio_engine is not None


def test_version_is_set() -> None:
    assert hasattr(klio_engine, "__version__")
    assert isinstance(klio_engine.__version__, str)
    assert len(klio_engine.__version__) > 0

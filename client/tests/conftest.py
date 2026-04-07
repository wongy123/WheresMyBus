"""
Shared pytest fixtures and sys.path setup for the WheresMyBus client test suite.

This module runs before any test file is imported, so it can safely stub out
the `api` module that blueprints and helpers import at module load time.
"""
import sys
import os
import types
import unittest.mock as mock

# Make the client/ directory importable so helpers, blueprints, and app can
# be imported by test files without relative-path gymnastics.
_client_dir = os.path.join(os.path.dirname(__file__), "..")
if _client_dir not in sys.path:
    sys.path.insert(0, _client_dir)

# ---------------------------------------------------------------------------
# Stub out the `api` module before anything else is imported.
# Blueprints do `from api import api_get` at module level; they capture the
# function object at that point.  We put a shared Mock into sys.modules so
# that every module that does `from api import api_get` gets the same object,
# which tests can then configure via the `mock_api` fixture below.
# ---------------------------------------------------------------------------
_api_mod = types.ModuleType("api")
_api_mock_fn = mock.Mock(return_value=None)
_api_mod.api_get = _api_mock_fn

if "api" not in sys.modules:
    sys.modules["api"] = _api_mod

import pytest


@pytest.fixture
def mock_api():
    """
    Yields the shared api_get Mock, reset to a clean state before each test.

    Use this fixture in tests that need to control what the API returns:

        def test_something(client, mock_api):
            mock_api.return_value = {"data": [...]}
            resp = client.get("/stops/600028")
    """
    _api_mock_fn.reset_mock()
    _api_mock_fn.return_value = None
    _api_mock_fn.side_effect = None
    yield _api_mock_fn


@pytest.fixture(scope="session")
def app():
    """Create and return the Flask test application (one per test session)."""
    from app import create_app
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture
def client(app):
    """Return a Flask test client."""
    return app.test_client()

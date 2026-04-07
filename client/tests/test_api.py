"""Tests for client/api.py — the thin HTTP client that wraps requests.get."""
import sys
import os
import importlib.util
import pytest
from unittest.mock import MagicMock, patch

# Load the real api.py module under an alias so the stub in sys.modules["api"]
# (installed by conftest.py) does not shadow it.
_client_dir = os.path.join(os.path.dirname(__file__), "..")
spec = importlib.util.spec_from_file_location(
    "_api_real", os.path.join(_client_dir, "api.py")
)
_api_real = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_api_real)


def _mock_response(status_code=200, json_data=None):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    return resp


class TestApiGet:
    def test_success_returns_parsed_json(self):
        payload = {"data": [{"stop_id": "600028", "stop_name": "Roma St Station"}]}
        with patch("requests.get", return_value=_mock_response(200, payload)):
            result = _api_real.api_get("stops/search", {"q": "Roma"})
        assert result == payload

    def test_404_returns_none(self):
        with patch("requests.get", return_value=_mock_response(404)):
            result = _api_real.api_get("stops/UNKNOWN999")
        assert result is None

    def test_non_404_error_raises(self):
        resp = _mock_response(500)
        resp.raise_for_status.side_effect = Exception("500 Server Error")
        with patch("requests.get", return_value=resp):
            with pytest.raises(Exception, match="500"):
                _api_real.api_get("some/path")

    def test_params_forwarded_to_requests(self):
        with patch("requests.get", return_value=_mock_response(200, {})) as mock_get:
            _api_real.api_get("stops/search", {"q": "Central", "limit": "5"})
        _, kwargs = mock_get.call_args
        assert kwargs.get("params") == {"q": "Central", "limit": "5"}

    def test_empty_params_forwarded_as_empty_dict(self):
        with patch("requests.get", return_value=_mock_response(200, {})) as mock_get:
            _api_real.api_get("stops/search")
        _, kwargs = mock_get.call_args
        assert kwargs.get("params") == {}

    def test_url_constructed_from_path(self):
        with patch("requests.get", return_value=_mock_response(200, {})) as mock_get:
            _api_real.api_get("stops/600028")
        url = mock_get.call_args[0][0]
        assert "stops/600028" in url

    def test_timeout_default_applied(self):
        with patch("requests.get", return_value=_mock_response(200, {})) as mock_get:
            _api_real.api_get("stops/600028")
        _, kwargs = mock_get.call_args
        assert kwargs.get("timeout") == 15

"""
Integration tests for Flask blueprint routes.

Tests use the Flask test client and the `mock_api` fixture (from conftest.py)
to control what `api_get` returns, without making real HTTP calls to the API server.
"""
import pytest


class TestStopBlueprint:
    def test_unknown_stop_returns_404(self, client, mock_api):
        mock_api.return_value = None

        resp = client.get("/stops/UNKNOWN999")

        assert resp.status_code == 404

    def test_stop_suggest_empty_query_returns_200(self, client, mock_api):
        # No q param → api_get should not be called; returns empty list
        resp = client.get("/hx/stops/suggest")

        assert resp.status_code == 200
        mock_api.assert_not_called()

    def test_stop_suggest_with_query_calls_api(self, client, mock_api):
        mock_api.return_value = {
            "data": [
                {"stop_id": "600028", "stop_name": "Roma St Station", "stop_code": "600028"},
            ],
            "pagination": {
                "page": 1, "total": 1, "pageCount": 1,
                "hasNext": False, "hasPrev": False, "limit": 5,
            },
        }

        resp = client.get("/hx/stops/suggest?q=Roma")

        assert resp.status_code == 200
        mock_api.assert_called_once()
        call_path = mock_api.call_args[0][0]
        assert "stops/search" in call_path

    def test_nearby_missing_coords_returns_200_with_error_state(self, client, mock_api):
        # lat/lng missing → renders template with error message, not a 4xx
        resp = client.get("/hx/stops/nearby")

        assert resp.status_code == 200
        mock_api.assert_not_called()


class TestRouteBlueprint:
    def test_unknown_route_returns_404(self, client, mock_api):
        mock_api.return_value = None

        resp = client.get("/routes/UNKNOWN999")

        assert resp.status_code == 404

    def test_route_suggest_empty_query_returns_200(self, client, mock_api):
        resp = client.get("/hx/routes/suggest")

        assert resp.status_code == 200
        mock_api.assert_not_called()

    def test_route_suggest_with_query_calls_api(self, client, mock_api):
        mock_api.return_value = {
            "data": [
                {"route_id": "66-305", "route_short_name": "66", "route_type": 3},
            ],
            "pagination": {
                "page": 1, "total": 1, "pageCount": 1,
                "hasNext": False, "hasPrev": False, "limit": 5,
            },
        }

        resp = client.get("/hx/routes/suggest?q=66")

        assert resp.status_code == 200
        mock_api.assert_called_once()
        call_path = mock_api.call_args[0][0]
        assert "routes/search" in call_path


class TestHomeAndStatic:
    def test_home_page_returns_200(self, client):
        resp = client.get("/")

        assert resp.status_code == 200

    def test_about_page_returns_200(self, client):
        resp = client.get("/about")

        assert resp.status_code == 200

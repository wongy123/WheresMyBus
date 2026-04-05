import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Stub out api_get so helpers.py can be imported without a running API server
import unittest.mock as mock
import importlib, types

api_mod = types.ModuleType("api")
api_mod.api_get = mock.Mock(return_value=None)
sys.modules["api"] = api_mod

from helpers import get_line_names, build_display_routes


class TestGetLineNames:
    def test_gold_coast_variant(self):
        assert "Gold Coast Line" in get_line_names("BNVL")

    def test_beenleigh_variant(self):
        assert "Beenleigh Line" in get_line_names("BNVL")

    def test_single_line_variant(self):
        assert get_line_names("BRVL") == ["Gold Coast Line"]

    def test_airport_override_brbr(self):
        assert get_line_names("BRBR") == ["Airport Line"]

    def test_airport_override_bdbr(self):
        assert get_line_names("BDBR") == ["Airport Line"]

    def test_clbr_both_lines(self):
        names = get_line_names("CLBR")
        assert "Airport Line" in names
        assert "Cleveland Line" in names

    def test_lowercase_input(self):
        assert "Gold Coast Line" in get_line_names("bnvl")

    def test_unknown_returns_empty(self):
        assert get_line_names("ZZZZ") == []

    def test_empty_string_returns_empty(self):
        assert get_line_names("") == []


class TestBuildDisplayRoutes:
    def _bus_route(self, short_name):
        return {
            "route_id": short_name,
            "route_short_name": short_name,
            "route_type": 3,
            "route_color": "0079C2",
            "route_text_color": "FFFFFF",
        }

    def _train_route(self, short_name):
        return {
            "route_id": short_name,
            "route_short_name": short_name,
            "route_type": 2,
            "route_color": "800080",
            "route_text_color": "FFFFFF",
        }

    def test_bus_routes_unchanged(self):
        result = build_display_routes([self._bus_route("120"), self._bus_route("130")])
        assert len(result) == 2
        assert result[0]["display"] == "120"
        assert result[0]["filter_key"] == "120"
        assert result[0]["is_line"] is False

    def test_train_variants_grouped_by_line(self):
        routes = [
            self._train_route("BRVL"),
            self._train_route("VLBR"),
        ]
        result = build_display_routes(routes)
        assert len(result) == 1
        chip = result[0]
        assert chip["display"] == "Gold Coast"
        assert chip["is_line"] is True
        # Both variants must appear in filter_key
        keys = set(chip["filter_key"].split(","))
        assert "BRVL" in keys
        assert "VLBR" in keys

    def test_variant_belonging_to_two_lines_creates_two_chips(self):
        # BNVL belongs to both Beenleigh Line and Gold Coast Line
        result = build_display_routes([self._train_route("BNVL")])
        displays = {r["display"] for r in result}
        assert "Gold Coast" in displays
        assert "Beenleigh" in displays

    def test_same_variant_not_duplicated_in_filter_key(self):
        # BNVL and VLBN both belong to Beenleigh+Gold Coast; each should appear once per chip
        routes = [self._train_route("BNVL"), self._train_route("VLBN")]
        result = build_display_routes(routes)
        for chip in result:
            variants = chip["filter_key"].split(",")
            assert len(variants) == len(set(variants)), "duplicate in filter_key"

    def test_mixed_bus_and_train(self):
        routes = [
            self._bus_route("120"),
            self._train_route("BRVL"),
            self._bus_route("66"),
        ]
        result = build_display_routes(routes)
        displays = [r["display"] for r in result]
        assert "120" in displays
        assert "66" in displays
        assert "Gold Coast" in displays

    def test_unknown_train_falls_back_to_individual_chip(self):
        result = build_display_routes([{
            "route_id": "ZZZZ",
            "route_short_name": "ZZZZ",
            "route_type": 2,
            "route_color": "800080",
            "route_text_color": "FFFFFF",
        }])
        assert len(result) == 1
        assert result[0]["display"] == "ZZZZ"
        assert result[0]["is_line"] is False

    def test_empty_input(self):
        assert build_display_routes([]) == []

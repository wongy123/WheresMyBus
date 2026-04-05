"""Shared helper functions for the WheresMyBus client."""

from api import api_get


def get_route_directions(route_id):
    """Fetch available directions for a route from the API.

    Returns (available_directions, default_direction) where
    available_directions is a list of ints (e.g. [0, 1]) and
    default_direction is an int.
    """
    data = api_get(f"routes/{route_id}/directions") or {}
    available = [d for d in data.get("available_directions", []) if d in (0, 1)]
    default = data.get("default_direction", 0)
    if default not in available:
        default = available[0] if available else 0
    return available, default


def validate_direction(direction, available_directions):
    """Validate and normalize a direction parameter.

    Returns the direction_id as int if valid, or the first available direction.
    available_directions is a list of ints, e.g. [0, 1].
    """
    if direction is not None:
        try:
            d = int(direction)
            if d in available_directions:
                return d
        except (ValueError, TypeError):
            pass
    return available_directions[0] if available_directions else 0


_TERMINAL_LINE = {
    "VL": "Gold Coast Line",
    "BN": "Beenleigh Line",
    "BD": "Doomben Line",
    "CA": "Caboolture Line",
    "NA": "Sunshine Coast Line",
    "GY": "Sunshine Coast Line",
    "CL": "Cleveland Line",
    "DB": "Doomben Line",
    "FG": "Ferny Grove Line",
    "IP": "Ipswich/Rosewood Line",
    "RW": "Ipswich/Rosewood Line",
    "SH": "Shorncliffe Line",
    "SP": "Springfield Line",
    "RP": "Redcliffe Peninsula Line",
}

_SHORT_NAME_OVERRIDE = {
    "BRBR": ["Airport Line"],
    "CLBR": ["Airport Line", "Cleveland Line"],
    "BDBR": ["Airport Line"],
}

# Official Translink train line colors (hardcoded for consistency)
_LINE_COLORS = {
    "Airport Line": ("A0A0A0", "FFFFFF"),  # Grey
    "Beenleigh Line": ("E31837", "FFFFFF"),  # Red
    "Caboolture Line": ("008752", "FFFFFF"),  # Green
    "Cleveland Line": ("00467F", "FFFFFF"),  # Dark Blue
    "Doomben Line": ("A54399", "FFFFFF"),  # Purple
    "Ferny Grove Line": ("E31837", "FFFFFF"),  # Red
    "Gold Coast Line": ("FFC425", "000000"),  # Yellow
    "Ipswich/Rosewood Line": ("008752", "FFFFFF"),  # Green
    "Redcliffe Peninsula Line": ("1578BE", "FFFFFF"),  # Light Blue
    "Shorncliffe Line": ("00467F", "FFFFFF"),  # Dark Blue
    "Springfield Line": ("1578BE", "FFFFFF"),  # Light Blue
    "Sunshine Coast Line": ("008752", "FFFFFF"),  # Green
}

_LINE_COLOR_PRIORITY = {
    "Airport Line": ["BRBR", "BDBR", "CLBR"],
    "Doomben Line": ["BRDB", "DBBR", "DBBN", "VLDB", "CLDB"],
    "Cleveland Line": ["CLBR", "BRCL"],
    "Ferny Grove Line": ["FGBR", "FGCL"],
    "Caboolture Line": ["BRCA", "CABR"],
    "Sunshine Coast Line": ["BRNA", "NABR"],
    "Ipswich/Rosewood Line": ["BRIP", "BRRW"],
}


def get_line_color(line_name):
    """Get the official color for a train line.
    
    Returns (route_color, route_text_color) tuple, or (None, None) if not a known line.
    """
    return _LINE_COLORS.get(line_name, (None, None))


def get_line_names(short_name):
    if not short_name:
        return []
    upper = short_name.upper()
    if upper in _SHORT_NAME_OVERRIDE:
        return list(_SHORT_NAME_OVERRIDE[upper])
    if len(upper) < 4:
        return []
    origin, dest = upper[:2], upper[2:4]
    seen = []
    for code in (origin, dest):
        name = _TERMINAL_LINE.get(code)
        if name and name not in seen:
            seen.append(name)
    return seen


def build_display_routes(routes):
    result = []
    line_chip_map = {}
    line_routes = {}

    for r in routes:
        rt = r.get("route_type")
        color = r.get("route_color") or "CCCCCC"
        text_color = r.get("route_text_color") or "000000"
        short = r.get("route_short_name", "")

        if rt not in (2, 12):
            result.append({
                "display": short,
                "filter_key": short,
                "route_color": color,
                "route_text_color": text_color,
                "is_line": False,
            })
            continue

        line_names = get_line_names(short)
        if not line_names:
            result.append({
                "display": short,
                "filter_key": short,
                "route_color": color,
                "route_text_color": text_color,
                "is_line": False,
            })
            continue

        for line_name in line_names:
            line_tag = line_name.replace(" Line", "").strip()
            if line_name not in line_chip_map:
                chip = {
                    "display": line_tag,
                    "_variants": [short],
                    "filter_key": short,
                    "route_color": color,
                    "route_text_color": text_color,
                    "is_line": True,
                }
                result.append(chip)
                line_chip_map[line_name] = chip
                line_routes[line_name] = [r]
            else:
                chip = line_chip_map[line_name]
                if short not in chip["_variants"]:
                    chip["_variants"].append(short)
                    chip["filter_key"] = ",".join(chip["_variants"])
                    line_routes[line_name].append(r)

    for line_name, chip in line_chip_map.items():
        line_color, line_text_color = get_line_color(line_name)
        if line_color:
            chip["route_color"] = line_color
            chip["route_text_color"] = line_text_color
        else:
            priority = _LINE_COLOR_PRIORITY.get(line_name, [])
            routes_for_line = line_routes.get(line_name, [])
            for preferred in priority:
                for r in routes_for_line:
                    if r.get("route_short_name") == preferred:
                        chip["route_color"] = r.get("route_color") or "CCCCCC"
                        chip["route_text_color"] = r.get("route_text_color") or "000000"
                        break
                else:
                    continue
                break

    for item in result:
        item.pop("_variants", None)

    return result

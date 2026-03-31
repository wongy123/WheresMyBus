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

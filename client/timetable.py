# timetable.py
import os
from concurrent.futures import ThreadPoolExecutor
from flask import Blueprint, render_template, request, abort
from api import api_get
from helpers import get_route_directions, validate_direction

bp = Blueprint("timetable", __name__)
DEFAULT_DURATION = int(os.environ.get("DURATION_SECONDS", "7200"))  # 2h

# ---------- Entry ----------
@bp.route("/timetable")
def timetable_index():
    return render_template("timetable/index.html")

# ---------- Shareable pages ----------
@bp.route("/timetable/stop/<stop_id>")
def timetable_by_stop(stop_id: str):
    stop = api_get(f"stops/{stop_id}")
    if stop is None:
        abort(404)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 10, type=int)
    platforms = []
    if stop.get("location_type") == 1:
        platforms_data = api_get(f"stops/{stop_id}/platforms") or {}
        platforms = platforms_data.get("data", [])
    return render_template("timetable/stop.html", stop=stop, duration=duration, page=page, limit=limit, platforms=platforms)

@bp.route("/timetable/route/<route_id>")
def timetable_by_route(route_id: str):
    route = api_get(f"routes/{route_id}")
    if route is None:
        abort(404)
    direction = request.args.get("direction", default=0, type=int)
    duration = request.args.get("duration", type=int) or 3600
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 10, type=int)
    available_directions, default_direction = get_route_directions(route_id)
    direction = validate_direction(direction, available_directions)
    return render_template("timetable/route.html",
                           route=route, direction=direction, duration=duration,
                           page=page, limit=limit,
                           available_directions=available_directions,
                           default_direction=default_direction)

# ---------- HTMX fragments ----------
@bp.get("/hx/timetable/stop/<stop_id>")
def hx_timetable_stop(stop_id: str):
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 10, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    params = {"page": page, "limit": limit, "duration": duration}
    routes = request.args.get("routes", "").strip()
    if routes:
        params["routes"] = routes
    resp = api_get(f"stops/{stop_id}/timetable", params)

    if resp is None:
        abort(404)

    rows, pagination = [], {}
    if isinstance(resp, dict):
        rows = resp.get("data") or resp.get("items") or []
        pagination = resp.get("pagination") or {}
    elif isinstance(resp, list):
        rows = resp

    hx_target = request.args.get("hx_target", "#tt-stop-results")
    return render_template("timetable/_stop_results.html",
                           rows=rows, pagination=pagination,
                           stop_id=stop_id, duration=duration, page=page, limit=limit,
                           hx_target=hx_target)

@bp.get("/hx/timetable/route/<route_id>/upcoming")
def hx_timetable_route(route_id: str):
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 10, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    available_directions, _ = get_route_directions(route_id)
    direction = validate_direction(request.args.get("direction", type=int), available_directions)

    resp = api_get(f"routes/{route_id}/upcoming",
                   {"page": page, "limit": limit, "duration": duration, "direction": direction})

    rows, pagination = [], {}
    if isinstance(resp, dict):
        rows = resp.get("data") or resp.get("items") or []
        pagination = resp.get("pagination") or {}
    elif isinstance(resp, list):
        rows = resp

    return render_template("timetable/_route_results.html",
                           rows=rows, pagination=pagination,
                           route_id=route_id, direction=direction, duration=duration,
                           page=page, limit=limit)

@bp.get("/hx/timetable/route/<route_id>/schedule")
def hx_timetable_route_schedule(route_id: str):
    available_directions, _ = get_route_directions(route_id)
    direction = validate_direction(request.args.get("direction", type=int), available_directions)

    data = api_get(f"routes/{route_id}/schedule", {"direction": direction}) or {}
    stops = data.get("stops", [])
    trips = data.get("trips", [])

    return render_template(
        "timetable/_route_schedule.html",
        stops=stops, trips=trips,
        route_id=route_id, direction=direction,
    )

@bp.get("/hx/timetable/route/<route_id>/diagram")
def hx_timetable_route_diagram(route_id: str):
    available_directions, _ = get_route_directions(route_id)
    direction = validate_direction(request.args.get("direction", type=int), available_directions)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION

    # Determine the other direction so we can show all vehicles on the map.
    other_direction = next((d for d in available_directions if d != direction), None)

    with ThreadPoolExecutor(max_workers=4) as pool:
        route_future = pool.submit(api_get, f"routes/{route_id}")
        stops_future = pool.submit(api_get, f"routes/{route_id}/stops", {"direction": direction})
        upcoming_future = pool.submit(
            api_get,
            f"routes/{route_id}/upcoming",
            {"direction": direction, "duration": duration, "limit": 100},
        )
        # Fetch other direction's upcoming trips for the map (vehicles from both directions)
        other_upcoming_future = (
            pool.submit(api_get, f"routes/{route_id}/upcoming",
                        {"direction": other_direction, "duration": duration, "limit": 100})
            if other_direction is not None else None
        )

        route = route_future.result() or {}
        stops_resp = stops_future.result() or {}
        upcoming_resp = upcoming_future.result() or {}
        other_upcoming_resp = other_upcoming_future.result() or {} if other_upcoming_future else {}

    route_type = route.get("route_type", 3)
    route_color = route.get("route_color") or ""

    stops = stops_resp.get("data", [])
    trips = upcoming_resp.get("data", [])

    # Pick most recent RT update timestamp for the "updated at" footer
    updated_at = next(
        (t.get("realtime_updated_local") for t in trips if t.get("realtime_updated_local")),
        None
    )

    # Group active vehicles by canonical stop sequence for diagram positioning.
    # The API now provides canonical_stop_sequence directly.
    vehicles_by_seq = {}
    for t in trips:
        seq = t.get("canonical_stop_sequence")
        if seq is None:
            seq = t.get("stop_sequence")
        if seq is None:
            continue
        vehicles_by_seq.setdefault(seq, []).append(t)

    # Collect vehicles from BOTH directions for the geographic map.
    all_trips = trips + (other_upcoming_resp.get("data", []) if other_upcoming_resp else [])
    seen_trips = set()
    vehicle_positions = []
    for t in all_trips:
        tid = t.get("trip_id")
        if tid in seen_trips:
            continue
        seen_trips.add(tid)
        if t.get("vehicle_latitude") and t.get("vehicle_longitude"):
            vehicle_positions.append({
                "trip_id": tid,
                "headsign": t.get("trip_headsign", ""),
                "lat": t["vehicle_latitude"],
                "lon": t["vehicle_longitude"],
                "label": t.get("vehicle_label") or t.get("vehicle_id") or "",
                "minutes_away": t.get("minutes_away"),
                "stop_name": t.get("stop_name", ""),
            })

    return render_template(
        "timetable/_route_diagram.html",
        stops=stops, vehicles_by_seq=vehicles_by_seq,
        route_id=route_id, direction=direction, updated_at=updated_at,
        route_type=route_type, route_color=route_color, vehicle_positions=vehicle_positions,
    )
# timetable.py
import os
from concurrent.futures import ThreadPoolExecutor
from flask import Blueprint, render_template, request, abort, redirect, url_for
from api import api_get
from helpers import get_route_directions, validate_direction

bp = Blueprint("timetable", __name__)
DEFAULT_DURATION = int(os.environ.get("DURATION_SECONDS", "7200"))  # 2h

# ---------- Entry (redirected to home) ----------
@bp.route("/timetable")
def timetable_index():
    return redirect("/", 301)

# ---------- Legacy pages → redirect to detail pages ----------
@bp.route("/timetable/stop/<stop_id>")
def timetable_by_stop(stop_id: str):
    return redirect(f"/stops/{stop_id}", 301)

@bp.route("/timetable/route/<route_id>")
def timetable_by_route(route_id: str):
    return redirect(f"/routes/{route_id}", 301)

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

    with ThreadPoolExecutor(max_workers=3) as pool:
        route_future = pool.submit(api_get, f"routes/{route_id}")
        stops_future = pool.submit(api_get, f"routes/{route_id}/stops", {"direction": direction})
        upcoming_future = pool.submit(
            api_get,
            f"routes/{route_id}/upcoming",
            {"direction": direction, "duration": duration, "limit": 100},
        )

        route = route_future.result() or {}
        stops_resp = stops_future.result() or {}
        upcoming_resp = upcoming_future.result() or {}

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

    # Sort each group: longest ETA (or scheduled) at top, shortest at bottom.
    for seq in vehicles_by_seq:
        vehicles_by_seq[seq].sort(
            key=lambda t: t["minutes_away"] if t.get("minutes_away") is not None else float("inf"),
            reverse=True,
        )

    # Collect vehicles for the current direction only.
    seen_trips = set()
    vehicle_positions = []
    for t in trips:
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
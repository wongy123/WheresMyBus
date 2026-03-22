# timetable.py
import os
from datetime import datetime
import pytz
from flask import Blueprint, render_template, request, abort
import requests

_BRISBANE_TZ = pytz.timezone("Australia/Brisbane")

def _hms_to_sec(hms):
    """Parse HH:MM:SS (or HH:MM) to seconds since midnight. Returns None on failure."""
    if not hms:
        return None
    try:
        parts = hms.split(':')
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + (int(parts[2]) if len(parts) > 2 else 0)
    except Exception:
        return None

bp = Blueprint("timetable", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
DEFAULT_DURATION = int(os.environ.get("DURATION_SECONDS", "7200"))  # 2h

def api_get(path, params=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.get(url, params=params or {}, timeout=15)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

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
    return render_template("timetable/stop.html", stop=stop, duration=duration, page=page, limit=limit)

@bp.route("/timetable/route/<route_id>")
def timetable_by_route(route_id: str):
    route = api_get(f"routes/{route_id}")
    if route is None:
        abort(404)
    direction = request.args.get("direction", default=0, type=int)
    duration = request.args.get("duration", type=int) or 3600
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 10, type=int)
    if direction not in (0, 1):
        direction = 0
    return render_template("timetable/route.html",
                           route=route, direction=direction, duration=duration,
                           page=page, limit=limit)

# ---------- HTMX fragments ----------
@bp.get("/hx/timetable/stop/<stop_id>")
def hx_timetable_stop(stop_id: str):
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 10, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    resp = api_get(f"stops/{stop_id}/timetable", {"page": page, "limit": limit, "duration": duration})

    rows, pagination = [], {}
    if isinstance(resp, dict):
        rows = resp.get("data") or resp.get("items") or []
        pagination = resp.get("pagination") or {}
    elif isinstance(resp, list):
        rows = resp

    return render_template("timetable/_stop_results.html",
                           rows=rows, pagination=pagination,
                           stop_id=stop_id, duration=duration, page=page, limit=limit,
                           hx_target="#stop-timetable")

@bp.get("/hx/timetable/route/<route_id>/upcoming")
def hx_timetable_route(route_id: str):
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 10, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    direction = request.args.get("direction", default=0, type=int)
    if direction not in (0, 1):
        direction = 0

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
    direction = request.args.get("direction", 0, type=int)
    if direction not in (0, 1):
        direction = 0

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
    direction = request.args.get("direction", 0, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    if direction not in (0, 1):
        direction = 0

    route = api_get(f"routes/{route_id}") or {}
    route_type = route.get("route_type", 3)

    stops_resp = api_get(f"routes/{route_id}/stops", {"direction": direction}) or {}
    stops = stops_resp.get("data", [])

    upcoming_resp = api_get(f"routes/{route_id}/upcoming",
                            {"direction": direction, "duration": duration, "limit": 100}) or {}
    trips = upcoming_resp.get("data", [])

    # Annotate each trip with minutes_away to its next stop
    now_bne = datetime.now(_BRISBANE_TZ)
    now_sec = now_bne.hour * 3600 + now_bne.minute * 60 + now_bne.second
    for t in trips:
        eta_str = t.get("estimated_arrival_time") or t.get("scheduled_arrival_time")
        eta_sec = _hms_to_sec(eta_str)
        if eta_sec is not None:
            diff = eta_sec - now_sec
            if diff < -3600:   # handle rollover past midnight
                diff += 86400
            t["minutes_away"] = max(0, round(diff / 60))
        else:
            t["minutes_away"] = None

    # Group active vehicles by their actual current stop sequence (from RT feed),
    # falling back to the scheduled stop_sequence when live data is unavailable.
    vehicles_by_seq = {}
    for t in trips:
        seq = t.get("vehicle_current_stop_sequence") if t.get("vehicle_current_stop_sequence") is not None else t.get("stop_sequence")
        if seq is not None:
            vehicles_by_seq.setdefault(seq, []).append(t)

    # Pick most recent RT update timestamp for the "updated at" footer
    updated_at = next(
        (t.get("realtime_updated_local") for t in trips if t.get("realtime_updated_local")),
        None
    )

    # Build stop_sequence → stop_name lookup from the canonical stop list
    seq_to_stop_name = {
        s["stop_sequence"]: s["stop_name"]
        for s in stops
        if "stop_sequence" in s and "stop_name" in s
    }

    # Collect vehicles that have GPS positions for the map
    seen_trips = set()
    vehicle_positions = []
    for t in trips:
        tid = t.get("trip_id")
        if tid in seen_trips:
            continue
        seen_trips.add(tid)
        if t.get("vehicle_latitude") and t.get("vehicle_longitude"):
            # Use vehicle_current_stop_sequence from the RT feed for the actual next stop;
            # fall back to the timetable row's stop_name if not available or not found.
            cur_seq = t.get("vehicle_current_stop_sequence")
            next_stop = seq_to_stop_name.get(cur_seq) if cur_seq is not None else None
            vehicle_positions.append({
                "trip_id": tid,
                "headsign": t.get("trip_headsign", ""),
                "lat": t["vehicle_latitude"],
                "lon": t["vehicle_longitude"],
                "label": t.get("vehicle_label") or t.get("vehicle_id") or "",
                "minutes_away": t.get("minutes_away"),
                "stop_name": next_stop or t.get("stop_name", ""),
            })

    return render_template(
        "timetable/_route_diagram.html",
        stops=stops, vehicles_by_seq=vehicles_by_seq,
        route_id=route_id, direction=direction, updated_at=updated_at,
        route_type=route_type, vehicle_positions=vehicle_positions,
    )
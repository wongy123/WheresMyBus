# timetable.py
import os
from datetime import datetime
import pytz
from flask import Blueprint, render_template, request, abort
from api import api_get

_BRISBANE_TZ = pytz.timezone("Australia/Brisbane")

def _hms_to_sec(hms):
    """Parse HH:MM:SS (or HH:MM) to seconds since midnight. Returns None on failure.
    Normalises GTFS overflow hours (e.g. 24:19:00 → 1140)."""
    if not hms:
        return None
    try:
        parts = hms.split(':')
        sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + (int(parts[2]) if len(parts) > 2 else 0)
        return sec % 86400
    except Exception:
        return None

def _validate_direction(val):
    return val if val in (0, 1) else 0

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
    direction = _validate_direction(direction)
    return render_template("timetable/route.html",
                           route=route, direction=direction, duration=duration,
                           page=page, limit=limit)

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
    direction = _validate_direction(request.args.get("direction", default=0, type=int))

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
    direction = _validate_direction(request.args.get("direction", 0, type=int))

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
    direction = _validate_direction(request.args.get("direction", 0, type=int))
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION

    route = api_get(f"routes/{route_id}") or {}
    route_type = route.get("route_type", 3)
    route_color = route.get("route_color") or ""

    stops_resp = api_get(f"routes/{route_id}/stops", {"direction": direction}) or {}
    stops = stops_resp.get("data", [])

    upcoming_resp = api_get(f"routes/{route_id}/upcoming",
                            {"direction": direction, "duration": duration, "limit": 100}) or {}
    trips = upcoming_resp.get("data", [])

    # Annotate each trip with minutes_away to its next stop
    now_bne = datetime.now(_BRISBANE_TZ)
    now_sec = now_bne.hour * 3600 + now_bne.minute * 60 + now_bne.second
    for t in trips:
        eta_str = (t.get("estimated_departure_time") or t.get("scheduled_departure_time") or
                   t.get("estimated_arrival_time")   or t.get("scheduled_arrival_time"))
        eta_sec = _hms_to_sec(eta_str)
        if eta_sec is not None:
            diff = eta_sec - now_sec
            if diff < -3600:   # handle rollover past midnight
                diff += 86400
            t["minutes_away"] = max(0, round(diff / 60))
        else:
            t["minutes_away"] = None

    # Pick most recent RT update timestamp for the "updated at" footer
    updated_at = next(
        (t.get("realtime_updated_local") for t in trips if t.get("realtime_updated_local")),
        None
    )

    # Build canonical lookups from the representative stop list.
    # stop_id_to_seq lets us map a physical stop (identified by stop_id in the
    # trip row) to its canonical sequence number, regardless of how the trip
    # itself numbers its stops.  This is essential because different trips on
    # the same route can have different stop_sequence values for the same stops.
    seq_to_stop_name = {}
    seq_to_stop_coords = {}
    stop_id_to_seq = {}
    for s in stops:
        seq = s.get("stop_sequence")
        if seq is None:
            continue
        if "stop_name" in s:
            seq_to_stop_name[seq] = s["stop_name"]
        if s.get("stop_lat") is not None and s.get("stop_lon") is not None:
            seq_to_stop_coords[seq] = (float(s["stop_lat"]), float(s["stop_lon"]))
        if s.get("stop_id") is not None:
            stop_id_to_seq[str(s["stop_id"])] = seq
    sorted_seqs = sorted(seq_to_stop_name)

    def _advance_seq(trip_row, veh_seq):
        """Return (adjusted_seq, was_advanced).

        Advances to the next stop when the estimated departure time for the
        reported stop has already passed and real-time trip data is present.
        vehicle_current_stop_sequence is authoritative for which stop the
        vehicle is heading to; the server already corrects the schedule row
        when it disagrees, so no GPS projection is needed here.
        Only advances by one position.
        """
        try:
            idx = sorted_seqs.index(veh_seq)
        except ValueError:
            return veh_seq, False
        if idx + 1 >= len(sorted_seqs):
            return veh_seq, False  # already at last stop
        nxt = sorted_seqs[idx + 1]

        # Advance only when real-time trip data is present and the estimated
        # departure time has passed.  Without real_time_data the estimated time
        # equals the schedule, so a late bus would incorrectly advance past a
        # stop it hasn't reached yet.
        if trip_row.get("real_time_data"):
            dep_sec = _hms_to_sec(
                trip_row.get("estimated_departure_time") or trip_row.get("scheduled_departure_time")
            )
            if dep_sec is not None:
                diff = dep_sec - now_sec
                if diff < -86400 + 3600:  # handle rollover past midnight
                    diff += 86400
                if diff < 0:
                    return nxt, True

        return veh_seq, False

    # Group active vehicles by canonical stop sequence for diagram positioning.
    # Use the trip row's stop_id to resolve the canonical sequence, so that
    # buses on trips with different stop_sequence numbering still land at the
    # correct position on the diagram.  Fall back to the trip's own
    # stop_sequence only when the stop isn't in the canonical list.
    vehicles_by_seq = {}
    for t in trips:
        stop_id = str(t.get("stop_id") or "")
        seq = stop_id_to_seq.get(stop_id) if stop_id else None
        if seq is None:
            seq = t.get("stop_sequence")
        if seq is None:
            continue
        seq, _ = _advance_seq(t, seq)
        vehicles_by_seq.setdefault(seq, []).append(t)

    # Collect vehicles that have GPS positions for the map.
    # Use the trip row's stop_name and minutes_away directly — these already
    # reflect the correct next stop (the server-side getUpcomingByRoute fix
    # handles advancement when the vpos feed has moved ahead).  Client-side
    # sequence guessing via the canonical stop list is unreliable because
    # different trips on the same route can have different stop_sequence
    # numbering, so seq_to_stop_coords coordinates don't match.
    seen_trips = set()
    vehicle_positions = []
    for t in trips:
        tid = t.get("trip_id")
        if tid in seen_trips:
            continue
        seen_trips.add(tid)
        if t.get("vehicle_latitude") and t.get("vehicle_longitude"):
            stop_id = str(t.get("stop_id") or "")
            seq = stop_id_to_seq.get(stop_id) if stop_id else None
            if seq is None:
                seq = t.get("stop_sequence")
            adv_seq, was_advanced = _advance_seq(t, seq) if seq is not None else (seq, False)
            stop_name = seq_to_stop_name.get(adv_seq, t.get("stop_name", "")) if adv_seq is not None else t.get("stop_name", "")
            vehicle_positions.append({
                "trip_id": tid,
                "headsign": t.get("trip_headsign", ""),
                "lat": t["vehicle_latitude"],
                "lon": t["vehicle_longitude"],
                "label": t.get("vehicle_label") or t.get("vehicle_id") or "",
                "minutes_away": t.get("minutes_away") if not was_advanced else None,
                "stop_name": stop_name,
            })

    return render_template(
        "timetable/_route_diagram.html",
        stops=stops, vehicles_by_seq=vehicles_by_seq,
        route_id=route_id, direction=direction, updated_at=updated_at,
        route_type=route_type, route_color=route_color, vehicle_positions=vehicle_positions,
    )
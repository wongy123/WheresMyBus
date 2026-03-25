# stop.py
import os
from flask import Blueprint, render_template, request, abort, jsonify
from api import api_get

bp = Blueprint("stop", __name__)
BASE_PATH = os.environ.get("BASE_PATH", "")
SUGGEST_LIMIT_DEFAULT = int(os.environ.get("SUGGEST_LIMIT", "5"))

@bp.route("/stops")
def stops_index():
    return render_template("stops/index.html", BASE_PATH=BASE_PATH)

@bp.get("/hx/stops/suggest")
def stops_suggest():
    q = (request.args.get("q") or "").strip()
    dest = request.args.get("dest", "details")
    href_prefix = f"{BASE_PATH}/timetable/stop" if dest == "timetable" else f"{BASE_PATH}/stops"
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", SUGGEST_LIMIT_DEFAULT, type=int)
    suggest_id = request.args.get("suggest_id", "stop-suggest-list")

    items, pagination = [], {}
    if q:
        data = api_get("stops/search", {"q": q, "page": page, "limit": limit}) or {}
        items = data.get("data", [])
        pagination = data.get("pagination", {})

    suggest_url = f"{BASE_PATH}/hx/stops/suggest"
    return render_template(
        "stops/_suggest.html",
        q=q, items=items, pagination=pagination, limit=limit,
        href_prefix=href_prefix, suggest_id=suggest_id, suggest_url=suggest_url,
        BASE_PATH=BASE_PATH,
    )

@bp.get("/hx/stops/nearby")
def stops_nearby():
    lat = request.args.get("lat", type=float)
    lng = request.args.get("lng", type=float)
    dest = request.args.get("dest", "details")
    limit = request.args.get("limit", 5, type=int)
    href_prefix = f"{BASE_PATH}/timetable/stop" if dest == "timetable" else f"{BASE_PATH}/stops"

    items, error = [], None
    if lat is None or lng is None:
        error = "Could not read coordinates."
    else:
        data = api_get("stops/nearby", {"lat": lat, "lng": lng, "limit": limit}) or {}
        items = data.get("data", [])

    return render_template(
        "stops/_nearby.html",
        items=items, error=error, href_prefix=href_prefix, BASE_PATH=BASE_PATH,
    )

@bp.get("/hx/stops/nearby-json")
def stops_nearby_json():
    lat = request.args.get("lat", type=float)
    lng = request.args.get("lng", type=float)
    limit = request.args.get("limit", 8, type=int)
    if lat is None or lng is None:
        return jsonify({"data": []})
    data = api_get("stops/nearby", {"lat": lat, "lng": lng, "limit": limit}) or {}
    return jsonify(data)

@bp.get("/hx/stops/<stop_id>/vehicles")
def hx_stop_vehicles(stop_id: str):
    duration = request.args.get("duration", 3600, type=int)
    resp = api_get(f"stops/{stop_id}/timetable", {"page": 1, "limit": 50, "duration": duration})

    rows = []
    if isinstance(resp, dict):
        rows = resp.get("data") or []
    elif isinstance(resp, list):
        rows = resp

    seen = set()
    vehicles = []
    for row in rows:
        tid = row.get("trip_id")
        if not tid or tid in seen:
            continue
        seen.add(tid)
        if row.get("vehicle_latitude") and row.get("vehicle_longitude"):
            vehicles.append({
                "trip_id": tid,
                "route_id": row.get("route_id"),
                "route_short_name": row.get("route_short_name"),
                "route_color": row.get("route_color") or "",
                "route_text_color": row.get("route_text_color") or "",
                "trip_headsign": row.get("trip_headsign"),
                "direction_id": row.get("direction_id"),
                "lat": row["vehicle_latitude"],
                "lon": row["vehicle_longitude"],
                "label": row.get("vehicle_label") or "",
                "eta": (row.get("estimated_departure_time") or row.get("scheduled_departure_time") or
                        row.get("estimated_arrival_time")   or row.get("scheduled_arrival_time") or ""),
            })

    return render_template("stops/_vehicle_positions.html", vehicles=vehicles)


@bp.route("/stops/<stop_id>")
def stop_details(stop_id: str):
    details = api_get(f"stops/{stop_id}")
    if details is None:
        abort(404)

    nearby, routes = [], []
    if details.get("stop_lat") and details.get("stop_lon"):
        nearby_data = api_get("stops/nearby", {
            "lat": details["stop_lat"], "lng": details["stop_lon"], "limit": 9
        }) or {}
        # exclude the current stop from the nearby list
        nearby = [s for s in nearby_data.get("data", []) if s.get("stop_id") != stop_id]

    routes_data = api_get(f"stops/{stop_id}/routes") or {}
    routes = routes_data.get("data", [])

    platforms = []
    if details.get("location_type") == 1:
        platforms_data = api_get(f"stops/{stop_id}/platforms") or {}
        platforms = platforms_data.get("data", [])

    return render_template("stops/details.html", stop=details, nearby=nearby, routes=routes, platforms=platforms, BASE_PATH=BASE_PATH)

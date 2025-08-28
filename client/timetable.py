# timetable.py
import os
from flask import Blueprint, render_template, request, abort
import requests

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
    # Read duration from query (fallback 2h)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    return render_template("timetable/stop.html", stop=stop, duration=duration)

@bp.route("/timetable/route/<route_id>")
def timetable_by_route(route_id: str):
    route = api_get(f"routes/{route_id}")
    if route is None:
        abort(404)
    direction = request.args.get("direction", default=0, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    if direction not in (0, 1):
        direction = 0
    return render_template("timetable/route.html",
                           route=route, direction=direction, duration=duration)

# ---------- HTMX fragments ----------
@bp.get("/hx/timetable/stop/<stop_id>")
def hx_timetable_stop(stop_id: str):
    page = request.args.get("page", 1, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    data = api_get(f"stops/{stop_id}/timetable", {"page": page, "limit": 20, "duration": duration}) \
           or {"data": [], "pagination": {}}
    return render_template("timetable/_stop_results.html",
                           payload=data, stop_id=stop_id, duration=duration)

@bp.get("/hx/timetable/route/<route_id>/upcoming")
def hx_timetable_route(route_id: str):
    page = request.args.get("page", 1, type=int)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    direction = request.args.get("direction", default=0, type=int)
    if direction not in (0, 1):
        direction = 0
    data = api_get(f"routes/{route_id}/upcoming",
                   {"page": page, "limit": 20, "duration": duration, "direction": direction}) \
           or {"data": [], "pagination": {}}
    return render_template("timetable/_route_results.html",
                           payload=data, route_id=route_id, direction=direction, duration=duration)

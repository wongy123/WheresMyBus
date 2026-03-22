# stop.py
import os
from flask import Blueprint, render_template, request, abort, jsonify
import requests

bp = Blueprint("stop", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BASE_PATH = os.environ.get("BASE_PATH", "")
SUGGEST_LIMIT_DEFAULT = int(os.environ.get("SUGGEST_LIMIT", "5"))

def api_get(path, params=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.get(url, params=params or {}, timeout=15)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

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

@bp.route("/stops/<stop_id>")
def stop_details(stop_id: str):
    details = api_get(f"stops/{stop_id}")
    if details is None:
        abort(404)
    return render_template("stops/details.html", stop=details, BASE_PATH=BASE_PATH)

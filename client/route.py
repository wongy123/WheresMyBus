# route.py
import os
from flask import Blueprint, render_template, request, abort
import requests

bp = Blueprint("route", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BASE_PATH = os.environ.get("BASE_PATH", "")  # for subpath setups
SUGGEST_LIMIT_DEFAULT = int(os.environ.get("SUGGEST_LIMIT", "5"))

def api_get(path, params=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.get(url, params=params or {}, timeout=10)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

@bp.route("/routes")
def routes_index():
    return render_template("routes/index.html", BASE_PATH=BASE_PATH)

@bp.get("/hx/routes/suggest")
def routes_suggest():
    q = (request.args.get("q") or "").strip()
    dest = request.args.get("dest", "details")
    href_prefix = f"{BASE_PATH}/timetable/route" if dest == "timetable" else f"{BASE_PATH}/routes"

    # NEW: pagination params
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", SUGGEST_LIMIT_DEFAULT, type=int)
    # optional: unique target id when multiple suggest boxes exist
    suggest_id = request.args.get("suggest_id", "route-suggest-list")

    items, pagination = [], {}
    if q:
        data = api_get("routes/search", {"q": q, "page": page, "limit": limit}) or {}
        items = data.get("data", [])
        pagination = data.get("pagination", {})

    # expose the HX URL (with BASE_PATH) so the partial can call back correctly
    suggest_url = f"{BASE_PATH}/hx/routes/suggest"

    return render_template(
        "routes/_suggest.html",
        q=q,
        items=items,
        pagination=pagination,
        limit=limit,
        href_prefix=href_prefix,
        suggest_id=suggest_id,
        suggest_url=suggest_url,
        BASE_PATH=BASE_PATH,
    )

@bp.route("/routes/<route_id>")
def route_details(route_id: str):
    details = api_get(f"routes/{route_id}")
    if details is None:
        abort(404)
    return render_template("routes/details.html", route=details, BASE_PATH=BASE_PATH)

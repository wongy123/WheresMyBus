# route.py
import os
from flask import Blueprint, render_template, request, abort
import requests

bp = Blueprint("route", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BASE_PATH = os.environ.get("BASE_PATH", "")
SUGGEST_LIMIT = int(os.environ.get("SUGGEST_LIMIT", "8"))

def api_get(path, params=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.get(url, params=params or {}, timeout=10)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

@bp.route("/routes")
def routes_index():
    return render_template("routes/index.html")

@bp.get("/hx/routes/suggest")
def routes_suggest():
    q = (request.args.get("q") or "").strip()
    dest = request.args.get("dest", "details")  # "details" OR "timetable"
    if dest == "timetable":
        href_prefix = f"{BASE_PATH.rstrip('/')}/timetable/route"
    else:
        href_prefix = f"{BASE_PATH.rstrip('/')}/routes"
    items = []
    if q:
        data = api_get("routes/search", {"q": q, "limit": SUGGEST_LIMIT})
        if isinstance(data, dict):
            items = data.get("data", [])[:SUGGEST_LIMIT]
    return render_template("routes/_suggest.html", q=q, items=items, href_prefix=href_prefix)

@bp.route("/routes/<route_id>")
def route_details(route_id: str):
    details = api_get(f"routes/{route_id}")
    if details is None:
        abort(404)
    return render_template("routes/details.html", route=details)

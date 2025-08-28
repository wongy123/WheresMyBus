# stop.py
import os
from flask import Blueprint, render_template, request, abort
import requests

bp = Blueprint("stop", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
SUGGEST_LIMIT = int(os.environ.get("SUGGEST_LIMIT", "8"))

def api_get(path, params=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.get(url, params=params or {}, timeout=10)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

# ---------- Stops: index with typeahead ----------
@bp.route("/stops")
def stops_index():
    return render_template("stops/index.html")

@bp.get("/hx/stops/suggest")
def stops_suggest():
    q = (request.args.get("q") or "").strip()
    items = []
    if q:
        data = api_get("stops/search", {"q": q, "limit": SUGGEST_LIMIT})
        if isinstance(data, dict):
            items = data.get("data", [])[:SUGGEST_LIMIT]
    return render_template("stops/_suggest.html", q=q, items=items)

# ---------- Stop details (page) ----------
@bp.route("/stops/<stop_id>")
def stop_details(stop_id: str):
    details = api_get(f"stops/{stop_id}")
    if details is None:
        abort(404)
    # Fetch rating (small, fast) to display headline info; images/reviews lazy-load via HTMX
    rating = api_get(f"stops/{stop_id}/rating") or {}
    return render_template("stops/details.html", stop=details, rating=rating)

# ---------- HTMX fragments inside details ----------
@bp.get("/hx/stops/<stop_id>/rating")
def stop_rating(stop_id: str):
    rating = api_get(f"stops/{stop_id}/rating") or {}
    return render_template("stops/_rating.html", rating=rating)

@bp.get("/hx/stops/<stop_id>/images")
def stop_images(stop_id: str):
    page = request.args.get("page", 1, type=int)
    data = api_get(f"stops/{stop_id}/images", {"page": page, "limit": 20}) or {"items": [], "pagination": {}}
    return render_template("stops/_images.html", data=data, stop_id=stop_id)

@bp.get("/hx/stops/<stop_id>/reviews")
def stop_reviews(stop_id: str):
    page = request.args.get("page", 1, type=int)
    data = api_get(f"stops/{stop_id}/reviews", {"page": page, "limit": 20}) or {"items": [], "pagination": {}}
    return render_template("stops/_reviews.html", data=data, stop_id=stop_id)

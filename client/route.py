# route.py
import os
from datetime import datetime
from flask import Blueprint, render_template, request, abort
from api import api_get
from helpers import get_route_directions, validate_direction

bp = Blueprint("route", __name__)
BASE_PATH = os.environ.get("BASE_PATH", "")  # for subpath setups
SUGGEST_LIMIT_DEFAULT = int(os.environ.get("SUGGEST_LIMIT", "5"))

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

@bp.get("/hx/routes/suggest-map")
def routes_suggest_map():
    q = (request.args.get("q") or "").strip()
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", SUGGEST_LIMIT_DEFAULT, type=int)

    items, pagination = [], {}
    if q:
        data = api_get("routes/search", {"q": q, "page": page, "limit": limit}) or {}
        items = data.get("data", [])
        pagination = data.get("pagination", {})

    return render_template(
        "routes/_suggest_map.html",
        q=q,
        items=items,
        pagination=pagination,
        limit=limit,
        suggest_url=f"{BASE_PATH}/hx/routes/suggest-map",
        BASE_PATH=BASE_PATH,
    )

@bp.route("/routes/<route_id>")
def route_details(route_id: str):
    details = api_get(f"routes/{route_id}")
    if details is None:
        abort(404)
    available_directions, default_direction = get_route_directions(route_id)

    # For line slugs (is_line=True), use the slug for all HTMX/API sub-calls.
    # For regular routes, use the actual route_id from the DB.
    route_key = details.get("line_slug") if details.get("is_line") else details.get("route_id", route_id)

    # Format next_service_date for display if present
    next_service_date_display = None
    nsd = details.get("next_service_date")
    if nsd:
        try:
            dt = datetime.strptime(nsd, "%Y%m%d")
            next_service_date_display = dt.strftime("%A %-d %B %Y")
        except Exception:
            next_service_date_display = nsd

    today_date = datetime.now().strftime("%Y%m%d")
    # Auto-advance to next service date for routes with no service today
    initial_date = nsd if nsd else today_date

    return render_template(
        "routes/details.html",
        route=details,
        route_key=route_key,
        next_service_date_display=next_service_date_display,
        today_date=today_date,
        initial_date=initial_date,
        BASE_PATH=BASE_PATH,
        available_directions=available_directions,
        default_direction=default_direction,
    )

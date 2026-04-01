# alert.py
import os
from flask import Blueprint, render_template, request, abort
from api import api_get

bp = Blueprint("alert", __name__)
BASE_PATH = os.environ.get("BASE_PATH", "")


@bp.route("/alerts")
def alerts_index():
    page  = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 20, type=int)
    data  = api_get("alerts", {"page": page, "limit": limit}) or {}
    alerts     = data.get("data", [])
    pagination = data.get("pagination", {})
    return render_template("alerts/index.html",
                           alerts=alerts, pagination=pagination,
                           page=page, limit=limit, BASE_PATH=BASE_PATH)


@bp.get("/hx/alerts/banner")
def hx_alerts_banner():
    """HTMX partial — returns a compact banner if any alerts match the given stop/route."""
    route_id = request.args.get("route_id", "").strip() or None
    stop_id  = request.args.get("stop_id",  "").strip() or None

    if not route_id and not stop_id:
        return ""

    params = {}
    if route_id: params["route_id"] = route_id
    if stop_id:  params["stop_id"]  = stop_id

    data   = api_get("alerts", {**params, "limit": 5}) or {}
    alerts = data.get("data", [])
    if not alerts:
        return ""
    return render_template("common/_alerts_banner.html",
                           alerts=alerts, BASE_PATH=BASE_PATH)

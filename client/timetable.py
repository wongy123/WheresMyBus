# timetable.py
import os
from concurrent.futures import ThreadPoolExecutor
from flask import Blueprint, render_template, request, abort, redirect, url_for
from api import api_get
from helpers import get_route_directions, validate_direction

bp = Blueprint("timetable", __name__)
DEFAULT_DURATION = int(os.environ.get("DURATION_SECONDS", "7200"))  # 2h

# ---------- Entry (redirected to home) ----------
@bp.route("/timetable")
def timetable_index():
    return redirect("/", 301)

# ---------- Legacy pages → redirect to detail pages ----------
@bp.route("/timetable/stop/<stop_id>")
def timetable_by_stop(stop_id: str):
    return redirect(f"/stops/{stop_id}", 301)

@bp.route("/timetable/route/<route_id>")
def timetable_by_route(route_id: str):
    return redirect(f"/routes/{route_id}", 301)

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

    if resp is None:
        abort(404)

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
    available_directions, _ = get_route_directions(route_id)
    direction = validate_direction(request.args.get("direction", type=int), available_directions)

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
    available_directions, _ = get_route_directions(route_id)
    direction = validate_direction(request.args.get("direction", type=int), available_directions)

    # Forward an optional date param (YYYYMMDD) to the API.
    date_str = request.args.get("date", "").strip()
    api_params = {"direction": direction, "limit": 200}
    if date_str and len(date_str) == 8 and date_str.isdigit():
        api_params["date"] = date_str

    data = api_get(f"routes/{route_id}/schedule", api_params) or {}
    route_info = api_get(f"routes/{route_id}") or {}
    stops = data.get("stops", [])
    trips = data.get("trips", [])
    route_type = route_info.get("route_type")

    # Determine if this is a multi-variant (train line) result
    variant_short_names = sorted(set(
        t.get("route_short_name", "") for t in trips if t.get("route_short_name")
    ))
    # Only show variants for trains (route_type 2 or 12)
    is_train = route_type in (2, 12)
    is_multi_variant = len(variant_short_names) > 1

    # Build per-variant color map for badge styling
    variant_colors = {}
    for t in trips:
        sn = t.get("route_short_name")
        if sn and sn not in variant_colors and t.get("route_color"):
            variant_colors[sn] = {
                "bg": "#" + t["route_color"],
                "fg": "#" + (t.get("route_text_color") or "000000"),
            }

    return render_template(
        "timetable/_route_schedule.html",
        stops=stops, trips=trips,
        route_id=route_id, direction=direction,
        date=date_str or None,
        variant_short_names=variant_short_names,
        is_multi_variant=is_multi_variant,
        variant_colors=variant_colors,
        is_train=is_train,
    )

@bp.get("/hx/timetable/route/<route_id>/diagram")
def hx_timetable_route_diagram(route_id: str):
    available_directions, _ = get_route_directions(route_id)
    direction = validate_direction(request.args.get("direction", type=int), available_directions)
    duration = request.args.get("duration", type=int) or DEFAULT_DURATION
    selected_variant = request.args.get("variant", "").strip() or None

    # Use the selected variant's route_short_name for stops/shape so the diagram
    # shows only that variant's stops, not a merged multi-variant list.
    stops_route_id = selected_variant if selected_variant else route_id

    with ThreadPoolExecutor(max_workers=4) as pool:
        route_future   = pool.submit(api_get, f"routes/{route_id}")
        stops_future   = pool.submit(api_get, f"routes/{stops_route_id}/stops", {"direction": direction})
        upcoming_future = pool.submit(
            api_get,
            f"routes/{route_id}/upcoming",
            {"direction": direction, "duration": duration, "limit": 100},
        )
        # Fetch today's schedule (page 1, small limit) to discover all variants running today
        schedule_future = pool.submit(
            api_get,
            f"routes/{route_id}/schedule",
            {"direction": direction, "limit": 200},
        )

        route        = route_future.result()   or {}
        stops_resp   = stops_future.result()   or {}
        upcoming_resp = upcoming_future.result() or {}
        schedule_resp = schedule_future.result() or {}

    route_type  = route.get("route_type", 3)
    route_color = route.get("route_color") or ""

    stops     = stops_resp.get("data", [])
    all_trips = upcoming_resp.get("data", [])

    # Collect available variants from today's full schedule (not just live window)
    schedule_trips = schedule_resp.get("trips", [])
    available_variants = sorted(set(
        t.get("route_short_name") for t in schedule_trips if t.get("route_short_name")
    ))
    # Fall back to live trips if schedule returned nothing
    if not available_variants:
        available_variants = sorted(set(
            t.get("route_short_name") for t in all_trips if t.get("route_short_name")
        ))

    # Build per-variant color map for badge styling (same logic as schedule handler)
    variant_colors = {}
    for t in schedule_trips or all_trips:
        sn = t.get("route_short_name")
        if sn and sn not in variant_colors and t.get("route_color"):
            variant_colors[sn] = {
                "bg": "#" + t["route_color"],
                "fg": "#" + (t.get("route_text_color") or "000000"),
            }

    # If selected variant not in available, fall back to first available
    if selected_variant and selected_variant not in available_variants:
        selected_variant = None
    if not selected_variant and available_variants:
        selected_variant = available_variants[0]

    # Filter live trips to selected variant for multi-variant lines
    is_multi_variant = len(available_variants) > 1
    if is_multi_variant and selected_variant:
        trips = [t for t in all_trips if t.get("route_short_name") == selected_variant]
    else:
        trips = all_trips

    # Pick most recent RT update timestamp for the "updated at" footer
    updated_at = next(
        (t.get("realtime_updated_local") for t in trips if t.get("realtime_updated_local")),
        None
    )

    # Group active vehicles by canonical stop sequence for diagram positioning.
    # The API now provides canonical_stop_sequence directly.
    vehicles_by_seq = {}
    for t in trips:
        seq = t.get("canonical_stop_sequence")
        if seq is None:
            seq = t.get("stop_sequence")
        if seq is None:
            continue
        vehicles_by_seq.setdefault(seq, []).append(t)

    # Sort each group: longest ETA (or scheduled) at top, shortest at bottom.
    for seq in vehicles_by_seq:
        vehicles_by_seq[seq].sort(
            key=lambda t: t["minutes_away"] if t.get("minutes_away") is not None else float("inf"),
            reverse=True,
        )

    # Collect vehicles for the current direction only.
    seen_trips = set()
    vehicle_positions = []
    for t in trips:
        tid = t.get("trip_id")
        if tid in seen_trips:
            continue
        seen_trips.add(tid)
        if t.get("vehicle_latitude") and t.get("vehicle_longitude"):
            vehicle_positions.append({
                "trip_id": tid,
                "headsign": t.get("trip_headsign", ""),
                "lat": t["vehicle_latitude"],
                "lon": t["vehicle_longitude"],
                "label": t.get("vehicle_label") or t.get("vehicle_id") or "",
                "minutes_away": t.get("minutes_away"),
                "stop_name": t.get("stop_name", ""),
            })

    return render_template(
        "timetable/_route_diagram.html",
        stops=stops, vehicles_by_seq=vehicles_by_seq,
        route_id=route_id, direction=direction, updated_at=updated_at,
        route_type=route_type, route_color=route_color, vehicle_positions=vehicle_positions,
        available_variants=available_variants, selected_variant=selected_variant,
        is_multi_variant=is_multi_variant, variant_colors=variant_colors,
        is_train=route_type in (2, 12),
    )
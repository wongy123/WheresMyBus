# stop.py
import os
from flask import Blueprint, render_template, request, abort, session, flash, jsonify
import requests

bp = Blueprint("stop", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BASE_PATH = os.environ.get("BASE_PATH", "")
SUGGEST_LIMIT_DEFAULT = int(os.environ.get("SUGGEST_LIMIT", "5"))

def api_get(path, params=None, auth=False):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    headers = {}
    if auth and session.get("access_token"):
        headers["Authorization"] = f"Bearer {session['access_token']}"
    resp = requests.get(url, params=params or {}, headers=headers, timeout=15)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

def api_post(path, data=None, files=None, auth=False, json=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    headers = {}
    if auth and session.get("access_token"):
        headers["Authorization"] = f"Bearer {session['access_token']}"
    resp = requests.post(url, data=data, files=files, json=json, headers=headers, timeout=30)
    return resp

def api_put(path, json=None, auth=False):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    headers = {"Content-Type": "application/json"}
    if auth and session.get("access_token"):
        headers["Authorization"] = f"Bearer {session['access_token']}"
    resp = requests.put(url, json=json or {}, headers=headers, timeout=15)
    return resp

def api_delete(path, auth=False):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    headers = {}
    if auth and session.get("access_token"):
        headers["Authorization"] = f"Bearer {session['access_token']}"
    resp = requests.delete(url, headers=headers, timeout=15)
    return resp

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

@bp.route("/stops/<stop_id>")
def stop_details(stop_id: str):
    details = api_get(f"stops/{stop_id}")
    if details is None:
        abort(404)
    rating = api_get(f"stops/{stop_id}/rating") or {}
    # We render the page; user-specific review & images list can lazy-load via HTMX
    return render_template("stops/details.html", stop=details, rating=rating, BASE_PATH=BASE_PATH)

# ---------- Images list (unchanged except passing current_user) ----------
@bp.get("/hx/stops/<stop_id>/images")
def stop_images(stop_id: str):
    page = request.args.get("page", 1, type=int)
    data = api_get(f"stops/{stop_id}/images", {"page": page, "limit": 20}) or {"items": [], "pagination": {}}
    current_user = session.get("user")
    return render_template("stops/_images.html", data=data, stop_id=stop_id, current_user=current_user)

# ---------- Reviews list (public) ----------
@bp.get("/hx/stops/<stop_id>/reviews")
def stop_reviews(stop_id: str):
    page = request.args.get("page", 1, type=int)
    data = api_get(f"stops/{stop_id}/reviews", {"page": page, "limit": 20}) or {"items": [], "pagination": {}}
    return render_template("stops/_reviews.html", data=data, stop_id=stop_id)

# ---------- YOUR review (get form / submit / delete) ----------
@bp.get("/hx/stops/<stop_id>/review/form")
def stop_review_form(stop_id: str):
    # get current user's existing review (auth)
    review = None
    try:
        review = api_get(f"stops/{stop_id}/review", auth=True)
    except requests.HTTPError as e:
        # if 404 -> not found, show empty form
        pass
    return render_template("stops/_review_form.html", stop_id=stop_id, review=review)

@bp.put("/hx/stops/<stop_id>/review")
def stop_review_put(stop_id: str):
    if not session.get("access_token"):
        return render_template("common/_alert.html", cls="alert-danger", text="You must be logged in to review."), 401

    # parse strictly from form first (htmx default), fallback to json
    try:
        rating = int((request.form.get("rating") or "").strip())
    except Exception:
        rating = None
    comment = (request.form.get("comment") or "").strip()
    if rating is None or not (1 <= rating <= 5):
        return render_template("common/_alert.html", cls="alert-warning", text="Please choose a rating 1–5."), 400

    payload = {"rating": rating, "comment": comment}
    resp = api_put(f"stops/{stop_id}/review", json=payload, auth=True)
    if resp.status_code not in (200, 201):
        try:
            msg = resp.json().get("error") or resp.text
        except Exception:
            msg = resp.text
        return render_template("common/_alert.html", cls="alert-danger", text=f"Save failed: {msg}"), resp.status_code

    # nothing to swap; client will reload the page
    return ("", 204)

@bp.delete("/hx/stops/<stop_id>/review")
def stop_review_delete(stop_id: str):
    if not session.get("access_token"):
        return render_template("common/_alert.html", cls="alert-danger", text="You must be logged in."), 401
    resp = api_delete(f"stops/{stop_id}/review", auth=True)
    if resp.status_code not in (200, 204):
        try:
            msg = resp.json().get("error") or resp.text
        except Exception:
            msg = resp.text
        return render_template("common/_alert.html", cls="alert-danger", text=f"Delete failed: {msg}"), resp.status_code

    return ("", 204)

# ---------- Image upload & delete ----------
@bp.post("/hx/stops/<stop_id>/images")
def stop_image_upload(stop_id: str):
    if not session.get("access_token"):
        return render_template("common/_alert.html", cls="alert-danger", text="You must be logged in to upload."), 401
    f = request.files.get("file")
    if not f:
        return render_template("common/_alert.html", cls="alert-warning", text="Please choose an image."), 400

    # forward multipart to API
    files = {"file": (f.filename, f.stream, f.mimetype)}
    resp = api_post(f"stops/{stop_id}/images/", files=files, auth=True)
    if resp.status_code not in (200, 201):
        try:
            msg = resp.json().get("error") or resp.text
        except Exception:
            msg = resp.text
        return render_template("common/_alert.html", cls="alert-danger", text=f"Upload failed: {msg}"), resp.status_code

    # Return a small success alert; client will also refresh the images list via hx-trigger
    return render_template("common/_alert.html", cls="alert-success", text="Image uploaded.")

@bp.delete("/hx/stops/<stop_id>/images/<image_id>")
def stop_image_delete(stop_id: str, image_id: str):
    if not session.get("access_token"):
        return render_template("common/_alert.html", cls="alert-danger", text="You must be logged in."), 401
    resp = api_delete(f"stops/{stop_id}/images/{image_id}", auth=True)
    if resp.status_code not in (200, 204):
        try:
            msg = resp.json().get("error") or resp.text
        except Exception:
            msg = resp.text
        # surface forbidden/not_found nicely
        return render_template("common/_alert.html", cls="alert-danger", text=f"Delete failed: {msg}"), resp.status_code

    # Success; return an empty 204 so HTMX can remove the row
    return ("", 204)

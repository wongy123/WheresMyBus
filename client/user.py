# user.py
import os
from flask import Blueprint, render_template, request, session, make_response
import requests

bp = Blueprint("user", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BASE_PATH = os.environ.get("BASE_PATH", "")

def api_request(method, path, *, json=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    headers = {}
    if session.get("access_token"):
        headers["Authorization"] = f"Bearer {session['access_token']}"
    return requests.request(method, url, json=json, headers=headers, timeout=15)

@bp.route("/user")
def user_index():
    if not session.get("user"):
        return render_template("user/index.html", user_info=None, BASE_PATH=BASE_PATH)
    me = {}
    try:
        r = api_request("GET", "users/me")
        if r.status_code == 200:
            me = r.json()
    except Exception:
        me = {}
    return render_template("user/index.html", user_info=me, BASE_PATH=BASE_PATH)

@bp.get("/hx/user/me")
def hx_user_me():
    r = api_request("GET", "users/me")
    data = r.json() if r.status_code == 200 else {}
    return render_template("user/_me_card.html", user_info=data)

# --- HTMX: update password ---
@bp.put("/hx/user/password")
def hx_user_password():
    if not session.get("access_token"):
        return render_template("common/_alert.html", cls="alert-danger", text="You must be logged in."), 401

    # Support form or JSON (htmx default is form-encoded)
    new_pw = (request.form.get("password") or "").strip()
    confirm = (request.form.get("confirm") or "").strip()
    if not new_pw:
        return render_template("common/_alert.html", cls="alert-warning", text="Password cannot be empty."), 400
    if new_pw != confirm:
        return render_template("common/_alert.html", cls="alert-warning", text="Passwords do not match."), 400
    if len(new_pw) < 6:
        return render_template("common/_alert.html", cls="alert-warning", text="Use at least 6 characters."), 400

    resp = api_request("PUT", "users/me", json={"password": new_pw})
    if resp.status_code not in (200, 201):
        try:
            msg = resp.json().get("error") or resp.text
        except Exception:
            msg = resp.text
        return render_template("common/_alert.html", cls="alert-danger", text=f"Update failed: {msg}"), resp.status_code

    return render_template("common/_alert.html", cls="alert-success", text="Password updated successfully.")

# --- HTMX: delete account ---
@bp.delete("/hx/user")
def hx_user_delete():
    if not session.get("access_token"):
        from flask import render_template
        return render_template("common/_alert.html", cls="alert-danger", text="You must be logged in."), 401

    resp = api_request("DELETE", "users/me")
    if resp.status_code not in (200, 204):
        try:
            msg = resp.json().get("error") or resp.text
        except Exception:
            msg = resp.text
        from flask import render_template
        return render_template("common/_alert.html", cls="alert-danger", text=f"Delete failed: {msg}"), resp.status_code

    session.clear()
    out = make_response("", 204)
    out.headers["HX-Redirect"] = f"{BASE_PATH}/"
    return out
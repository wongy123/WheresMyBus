# auth.py
import os
from flask import Blueprint, render_template, request, redirect, session, flash
import requests

bp = Blueprint("auth", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BASE_PATH = os.environ.get("BASE_PATH", "")

def api_post(path, json=None, headers=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.post(url, json=json or {}, headers=headers or {}, timeout=15)
    if 400 <= resp.status_code < 600:
        try:
            return resp.json(), resp.status_code
        except Exception:
            return {"error": f"HTTP {resp.status_code}"}, resp.status_code
    return resp.json(), 200

@bp.get("/login")
def login_form():
    next_url = request.args.get("next") or f"{BASE_PATH}/"
    return render_template("auth/login.html", next_url=next_url)

@bp.get("/register")
def register_form():
    # We use Cognito hosted pages for registration as well.
    next_url = request.args.get("next") or f"{BASE_PATH}/"
    return render_template("auth/register.html", next_url=next_url)

# Start Cognito Hosted UI (optionally with provider=Google)
@bp.get("/auth/cognito/start")
def auth_cognito_start():
    next_url = request.args.get("next") or f"{BASE_PATH}/"
    provider = request.args.get("provider")
    session["post_login_redirect"] = next_url
    url = f"{API_BASE.rstrip('/')}/auth/cognito/login"
    if provider in ("Google",):
        url += f"?provider={provider}"
    return redirect(url)

# Backend redirects here with handoff code ?h=...
@bp.get("/auth/callback")
def auth_callback():
    h = request.args.get("h")
    if not h:
        flash("Missing handoff code.", "danger")
        return redirect(f"{BASE_PATH}/login")

    data, status = api_post("auth/cognito/redeem", json={"h": h})
    if status != 200:
        msg = (data or {}).get("error") or "Sign-in failed."
        flash(msg, "danger")
        return redirect(f"{BASE_PATH}/login")

    access_token = data.get("access_token")
    session["access_token"] = access_token

    # Fetch /api/me for display
    try:
        me = requests.get(
            f"{API_BASE.rstrip('/')}/users/me",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        session["user"] = me.json() if me.status_code == 200 else {}
    except Exception:
        session["user"] = {}

    flash("Logged in successfully.", "success")
    return redirect(session.pop("post_login_redirect", f"{BASE_PATH}/"))

@bp.post("/logout")
def logout():
    session.clear()
    flash("You’ve been logged out.", "info")
    ref = request.headers.get("Referer")
    return redirect(ref or f"{BASE_PATH}/")

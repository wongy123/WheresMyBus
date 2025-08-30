# auth.py
import os
from flask import Blueprint, render_template, request, redirect, url_for, session, flash
import requests

bp = Blueprint("auth", __name__)
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BASE_PATH = os.environ.get("BASE_PATH", "")

def api_post(path, json=None):
    url = f"{API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.post(url, json=json or {}, timeout=10)
    # Allow 4xx handling in-page
    if resp.status_code == 404:
        return None, 404
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

@bp.post("/login")
def login_submit():
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    next_url = request.form.get("next") or f"{BASE_PATH}/"

    payload = {"username": username, "password": password}
    data, status = api_post("auth/login", json=payload)

    if status != 200:
        msg = (data or {}).get("message") or (data or {}).get("error") or "Login failed."
        flash(msg, "danger")
        return render_template("auth/login.html", next_url=next_url, username=username), 400

    # Store in session
    session["access_token"] = data.get("accessToken")
    session["user"] = data.get("user") or {"username": username}
    flash("Logged in successfully.", "success")
    return redirect(next_url)

@bp.get("/register")
def register_form():
    next_url = request.args.get("next") or f"{BASE_PATH}/"
    return render_template("auth/register.html", next_url=next_url)

@bp.post("/register")
def register_submit():
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    next_url = request.form.get("next") or f"{BASE_PATH}/"

    payload = {"username": username, "password": password}
    data, status = api_post("auth/register", json=payload)

    if status != 200:
        msg = (data or {}).get("message") or (data or {}).get("error") or "Registration failed."
        flash(msg, "danger")
        return render_template("auth/register.html", next_url=next_url, username=username), 400

    # Auto-login after register
    session["access_token"] = data.get("accessToken")
    session["user"] = data.get("user") or {"username": username}
    flash("Registration successful. You are now logged in.", "success")
    return redirect(next_url)

@bp.post("/logout")
def logout():
    session.clear()
    flash("You’ve been logged out.", "info")
    # Redirect to Referer or home
    ref = request.headers.get("Referer")
    return redirect(ref or f"{BASE_PATH}/")

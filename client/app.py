# app.py
import os
from datetime import datetime
import pytz
from flask import Flask, render_template
from flask_htmx import HTMX

# Config from env
API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
# Browser-facing API URL — set this to the LAN/public URL when accessing from other devices.
# Defaults to API_BASE_URL so single-machine setups need no change.
API_BASE_PUBLIC = os.environ.get("API_BASE_URL_PUBLIC", API_BASE)
BASE_PATH = os.environ.get("BASE_PATH", "").rstrip("/")  # e.g. "/wheresmybus" or ""
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-secret")  # set a real secret in prod
BRISBANE_TZ = pytz.timezone("Australia/Brisbane")

def create_app():
    app = Flask(__name__, static_url_path=f'{BASE_PATH}/static')
    app.secret_key = FLASK_SECRET_KEY
    # If you want the session cookie scoped to the subpath only, uncomment:
    # app.config["SESSION_COOKIE_PATH"] = BASE_PATH or "/"
    HTMX(app)

    # -------- Template filters --------
    @app.template_filter("to_brisbane")
    def to_brisbane(iso_str, fmt="%d %b %Y %I:%M %p"):
        if not iso_str:
            return ""
        try:
            dt = datetime.fromisoformat(str(iso_str).replace("Z", "+00:00"))
            return dt.astimezone(BRISBANE_TZ).strftime(fmt)
        except Exception:
            return iso_str

    @app.template_filter("delay_info")
    def delay_info(seconds):
        """
        seconds: int or None (may be negative for early)
        Returns a dict: {status, label, cls}
        """
        try:
            if seconds is None:
                return {"status": "scheduled", "label": "Scheduled", "cls": "text-bg-secondary"}
            s = int(seconds)
            if s == 0:
                return {"status": "ontime", "label": "On time", "cls": "text-bg-success"}
            mins = abs(s) // 60
            if s > 0:
                return {"status": "late", "label": f"{mins}m late", "cls": "text-bg-warning"}
            else:
                return {"status": "early", "label": f"{mins}m early", "cls": "text-bg-info"}
        except Exception:
            return {"status": "scheduled", "label": "Scheduled", "cls": "text-bg-secondary"}

    # -------- Template globals --------
    @app.context_processor
    def inject_globals():
        return {
            "API_BASE_URL": API_BASE_PUBLIC,
            "BASE_PATH": BASE_PATH,
        }

    # -------- Routes --------
    # Mount home under BASE_PATH so it works at subdirectory deployments
    home_rule = f"{BASE_PATH}/" if BASE_PATH else "/"

    @app.route(home_rule)
    def home():
        return render_template("home.html")

    about_rule = f"{BASE_PATH}/about"
    @app.route(about_rule)
    def about():
        return render_template("about.html")

    # -------- Blueprints --------
    from route import bp as route_bp
    from stop import bp as stop_bp
    from timetable import bp as timetable_bp
    from map import bp as map_bp

    # Register all blueprints under the same BASE_PATH prefix
    app.register_blueprint(route_bp,     url_prefix=BASE_PATH or None)
    app.register_blueprint(stop_bp,      url_prefix=BASE_PATH or None)
    app.register_blueprint(timetable_bp, url_prefix=BASE_PATH or None)
    app.register_blueprint(map_bp,       url_prefix=BASE_PATH or None)

    return app

if __name__ == "__main__":
    app = create_app()
    app.run(debug=True, port=5000)

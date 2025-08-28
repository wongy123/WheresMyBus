# app.py
import os
from flask import Flask, render_template
from flask_htmx import HTMX
from datetime import datetime
import pytz

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")

def create_app():
    app = Flask(__name__)
    HTMX(app)
    BRISBANE_TZ = pytz.timezone("Australia/Brisbane")

    @app.template_filter("to_brisbane")
    def to_brisbane(iso_str, fmt="%Y-%m-%d %H:%M"):
        """Convert ISO string to Australia/Brisbane local time."""
        if not iso_str:
            return ""
        try:
            dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
            dt_local = dt.astimezone(BRISBANE_TZ)
            return dt_local.strftime(fmt)
        except Exception:
            return iso_str

    # Inject API base for templates
    @app.context_processor
    def inject_globals():
        return {"API_BASE_URL": API_BASE}

    # Home
    @app.route("/")
    def home():
        return render_template("home.html")

    # Blueprints
    from route import bp as route_bp
    from stop import bp as stop_bp
    app.register_blueprint(route_bp)
    app.register_blueprint(stop_bp)

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(debug=True, port=5050)

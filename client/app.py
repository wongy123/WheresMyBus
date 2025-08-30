# app.py
import os
from flask import Flask, render_template
from flask_htmx import HTMX
from datetime import datetime
import pytz

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")
BRISBANE_TZ = pytz.timezone("Australia/Brisbane")

def create_app():
    app = Flask(__name__)
    HTMX(app)

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
                return {"status": "late", "label": f"+{mins}m late", "cls": "text-bg-warning"}
            else:
                return {"status": "early", "label": f"-{mins}m early", "cls": "text-bg-info"}
        except Exception:
            return {"status": "scheduled", "label": "Scheduled", "cls": "text-bg-secondary"}

    @app.context_processor
    def inject_globals():
        return {"API_BASE_URL": API_BASE}

    @app.route("/")
    def home():
        return render_template("home.html")

    from route import bp as route_bp
    from stop import bp as stop_bp
    from timetable import bp as timetable_bp
    app.register_blueprint(route_bp)
    app.register_blueprint(stop_bp)
    app.register_blueprint(timetable_bp)

    return app

app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5050)
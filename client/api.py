# api.py — shared API helper for all blueprints
import os
import requests

_API_BASE = os.environ.get("API_BASE_URL", "http://localhost:3000/api")

def api_get(path, params=None, timeout=15):
    url = f"{_API_BASE.rstrip('/')}/{path.lstrip('/')}"
    resp = requests.get(url, params=params or {}, timeout=timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()

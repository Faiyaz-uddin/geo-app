"""Overhead: weather, place and space details for any spot on Earth.

Run:  python app.py   ->  http://127.0.0.1:5000
"""
import datetime as dt
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

OWM_KEY = os.getenv("OPENWEATHER_API_KEY", "").strip()
NASA_KEY = os.getenv("NASA_API_KEY", "DEMO_KEY").strip() or "DEMO_KEY"
OWM = "https://api.openweathermap.org"

app = Flask(__name__)
http = requests.Session()
http.headers.update({"User-Agent": "overhead-app/1.0"})

# ---------------------------------------------------------------- helpers
_cache = {}


def cached(key, ttl, producer):
    """Tiny in-memory TTL cache so we stay well inside free API limits."""
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = producer()
    _cache[key] = (now, value)
    return value


def get_json(url, params=None, timeout=8):
    r = http.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()


def safe(fn, *args, **kwargs):
    """Run an optional data source; a failure returns None instead of breaking the page."""
    try:
        return fn(*args, **kwargs)
    except Exception:
        return None


def fail(message, status=502):
    return jsonify({"error": message}), status


def upstream_error(exc):
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        code = exc.response.status_code
        if code == 401:
            return fail(
                "OpenWeather rejected the API key. New keys can take up to two hours "
                "to activate. Check OPENWEATHER_API_KEY in your .env file.", 401)
        if code == 429:
            return fail("OpenWeather rate limit reached. Try again in a minute.", 429)
        if code == 404:
            return fail("No data found for that location.", 404)
    if isinstance(exc, requests.Timeout):
        return fail("The weather service took too long to respond. Try again.", 504)
    return fail("Couldn't reach the weather service. Check your connection and try again.")


def need_key():
    if not OWM_KEY:
        return fail("Add your OpenWeather key as OPENWEATHER_API_KEY in the .env file.", 500)
    return None


# ------------------------------------------------------------------- moon
SYNODIC = 29.530588853
NEW_MOON_REF = dt.datetime(2000, 1, 6, 18, 14, tzinfo=dt.timezone.utc)
PHASE_NAMES = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous",
               "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"]


def moon_info(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    age = ((now - NEW_MOON_REF).total_seconds() / 86400) % SYNODIC
    phase = age / SYNODIC
    illumination = (1 - math.cos(2 * math.pi * phase)) / 2
    to_full = (SYNODIC / 2 - age) if age < SYNODIC / 2 else (SYNODIC * 1.5 - age)
    to_new = SYNODIC - age
    iso = lambda days: (now + dt.timedelta(days=days)).isoformat()
    return {
        "phase": round(phase, 4),
        "name": PHASE_NAMES[int(phase * 8 + 0.5) % 8],
        "illumination": round(illumination, 4),
        "age_days": round(age, 1),
        "next_full": iso(to_full),
        "next_new": iso(to_new),
    }


# ------------------------------------------------------------------ pages
@app.get("/")
def index():
    return render_template("index.html")


# -------------------------------------------------------------------- geo
@app.get("/api/search")
def api_search():
    if (err := need_key()):
        return err
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])
    try:
        rows = get_json(f"{OWM}/geo/1.0/direct", {"q": q, "limit": 5, "appid": OWM_KEY})
    except requests.RequestException as e:
        return upstream_error(e)
    return jsonify([
        {"name": r.get("name"), "state": r.get("state"), "country": r.get("country"),
         "lat": r["lat"], "lon": r["lon"]} for r in rows
    ])


@app.get("/api/reverse")
def api_reverse():
    if (err := need_key()):
        return err
    try:
        lat, lon = float(request.args["lat"]), float(request.args["lon"])
    except (KeyError, ValueError):
        return fail("lat and lon are required.", 400)
    try:
        rows = get_json(f"{OWM}/geo/1.0/reverse",
                        {"lat": lat, "lon": lon, "limit": 1, "appid": OWM_KEY})
    except requests.RequestException as e:
        return upstream_error(e)
    if not rows:
        return jsonify({"name": None, "state": None, "country": None, "lat": lat, "lon": lon})
    r = rows[0]
    return jsonify({"name": r.get("name"), "state": r.get("state"),
                    "country": r.get("country"), "lat": lat, "lon": lon})


# ---------------------------------------------------------------- weather
@app.get("/api/weather")
def api_weather():
    if (err := need_key()):
        return err
    try:
        lat, lon = float(request.args["lat"]), float(request.args["lon"])
    except (KeyError, ValueError):
        return fail("lat and lon are required.", 400)
    units = request.args.get("units", "metric")
    units = units if units in ("metric", "imperial") else "metric"

    base = {"lat": lat, "lon": lon, "appid": OWM_KEY}
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_now = pool.submit(get_json, f"{OWM}/data/2.5/weather", {**base, "units": units})
        f_fc = pool.submit(get_json, f"{OWM}/data/2.5/forecast", {**base, "units": units})
        f_air = pool.submit(safe, get_json, f"{OWM}/data/2.5/air_pollution", base)
        f_elev = pool.submit(safe, get_json, "https://api.open-meteo.com/v1/elevation",
                             {"latitude": lat, "longitude": lon})
    try:
        now, fc = f_now.result(), f_fc.result()
    except requests.RequestException as e:
        return upstream_error(e)

    air_raw, elev_raw = f_air.result(), f_elev.result()
    air = None
    if air_raw and air_raw.get("list"):
        item = air_raw["list"][0]
        air = {"aqi": item["main"]["aqi"], "components": item.get("components", {})}
    elevation = None
    if elev_raw and elev_raw.get("elevation"):
        elevation = elev_raw["elevation"][0]

    w = (now.get("weather") or [{}])[0]
    main, wind, sys_ = now.get("main", {}), now.get("wind", {}), now.get("sys", {})
    return jsonify({
        "units": units,
        "location": {
            "name": now.get("name"), "country": sys_.get("country"),
            "lat": now["coord"]["lat"], "lon": now["coord"]["lon"],
            "timezone": now.get("timezone", 0), "elevation": elevation,
        },
        "current": {
            "dt": now.get("dt"), "temp": main.get("temp"), "feels_like": main.get("feels_like"),
            "humidity": main.get("humidity"), "pressure": main.get("pressure"),
            "visibility": now.get("visibility"), "clouds": (now.get("clouds") or {}).get("all"),
            "wind_speed": wind.get("speed"), "wind_deg": wind.get("deg"), "wind_gust": wind.get("gust"),
            "id": w.get("id"), "main": w.get("main"), "description": w.get("description"),
            "sunrise": sys_.get("sunrise"), "sunset": sys_.get("sunset"),
            "rain_1h": (now.get("rain") or {}).get("1h"), "snow_1h": (now.get("snow") or {}).get("1h"),
        },
        "forecast": [{
            "dt": i["dt"], "temp": i["main"]["temp"], "feels": i["main"]["feels_like"],
            "pop": i.get("pop", 0), "id": i["weather"][0]["id"],
            "desc": i["weather"][0]["description"], "humidity": i["main"]["humidity"],
        } for i in fc.get("list", [])],
        "air": air,
        "moon": moon_info(),
    })


# ------------------------------------------------------------------ space
ISS_URL = "https://api.wheretheiss.at/v1/satellites/25544"


def _iss_path(offsets):
    stamp = int(time.time())
    ts = ",".join(str(stamp + o) for o in offsets)
    rows = get_json(f"{ISS_URL}/positions", {"timestamps": ts, "units": "kilometers"})
    return [[r["latitude"], r["longitude"]] for r in rows]


@app.get("/api/iss")
def api_iss():
    try:
        pos = cached("iss", 4, lambda: get_json(ISS_URL, {"units": "kilometers"}))
    except requests.RequestException:
        return fail("Couldn't reach the ISS tracker. Retrying shortly.")

    def build_paths():
        with ThreadPoolExecutor(max_workers=2) as pool:
            past = pool.submit(safe, _iss_path, [-600 * k for k in range(9, 0, -1)] + [0])
            future = pool.submit(safe, _iss_path, [600 * k for k in range(0, 10)])
        return {"past": past.result() or [], "future": future.result() or []}

    paths = cached("iss_paths", 120, build_paths)
    return jsonify({
        "lat": pos["latitude"], "lon": pos["longitude"], "altitude_km": pos["altitude"],
        "velocity_kmh": pos["velocity"], "visibility": pos.get("visibility"),
        "timestamp": pos["timestamp"], "path": paths,
    })


def _crew():
    data = get_json("http://api.open-notify.org/astros.json")
    people = [{"name": p["name"], "craft": p["craft"]} for p in data.get("people", [])]
    return {"number": data.get("number", len(people)), "people": people}


def _apod():
    return get_json("https://api.nasa.gov/planetary/apod", {"api_key": NASA_KEY}, timeout=10)


@app.get("/api/space")
def api_space():
    crew = safe(lambda: cached("crew", 3600, _crew))
    apod = safe(lambda: cached("apod", 6 * 3600, _apod))
    if apod:
        apod = {k: apod.get(k) for k in ("title", "explanation", "url", "hdurl", "media_type",
                                         "date", "copyright")}
    return jsonify({"crew": crew, "apod": apod, "moon": moon_info()})


import os

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")  # default local
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"

    app.run(host=host, port=port, debug=debug)

"""API tests: every route, with all outbound HTTP calls mocked (no network, no key needed)."""
import pytest
import requests

import app as overhead

# ---------------------------------------------------------------- canned data
CURRENT = {
    "coord": {"lat": 22.59, "lon": 88.31},
    "weather": [{"id": 802, "main": "Clouds", "description": "scattered clouds"}],
    "main": {"temp": 31.2, "feels_like": 36.0, "humidity": 70, "pressure": 1004},
    "visibility": 6000, "wind": {"speed": 3.1, "deg": 200, "gust": 5.2}, "clouds": {"all": 40},
    "dt": 1_790_000_000, "timezone": 19800, "name": "Howrah",
    "sys": {"country": "IN", "sunrise": 1_789_990_000, "sunset": 1_790_033_000},
}
FORECAST = {"list": [
    {"dt": 1_790_000_000 + i * 10800, "main": {"temp": 30 - i, "feels_like": 33, "humidity": 60},
     "pop": 0.3, "weather": [{"id": 500, "description": "light rain"}]} for i in range(40)]}
ROUTES = [  # first substring match wins
    ("/data/2.5/weather", CURRENT),
    ("/data/2.5/forecast", FORECAST),
    ("air_pollution", {"list": [{"main": {"aqi": 4}, "components": {"pm2_5": 80.1}}]}),
    ("open-meteo", {"elevation": [9.0]}),
    ("geo/1.0/direct", [{"name": "Howrah", "state": "West Bengal", "country": "IN", "lat": 22.59, "lon": 88.31},
                        {"name": "Howrah", "country": "IN", "lat": 1.0, "lon": 2.0}]),
    ("geo/1.0/reverse", [{"name": "Howrah", "state": "West Bengal", "country": "IN"}]),
    ("/positions", [{"latitude": 1.0, "longitude": 2.0}] * 10),
    ("satellites/25544", {"latitude": 10.0, "longitude": 20.0, "altitude": 420.5, "velocity": 27600.0,
                          "visibility": "daylight", "timestamp": 1_790_000_000}),
    ("astros", {"number": 2, "people": [{"name": "A", "craft": "ISS"}, {"name": "B", "craft": "Tiangong"}]}),
    ("planetary/apod", {"title": "A Nebula", "explanation": "Pretty.", "url": "https://x/y.jpg",
                        "media_type": "image", "service_version": "v1"}),
]


def http_error(status):
    resp = requests.Response()
    resp.status_code = status
    return requests.HTTPError(f"{status}", response=resp)


class FakeUpstream:
    """Stands in for app.get_json. Records calls; `fail[substring] = exc_or_value` overrides a route."""
    def __init__(self):
        self.calls, self.fail = [], {}

    def count(self, sub):
        return sum(sub in url for url, _ in self.calls)

    def params(self, sub):
        return next(p for url, p in self.calls if sub in url)

    def __call__(self, url, params=None, timeout=8):
        self.calls.append((url, params))
        for sub, value in self.fail.items():
            if sub in url:
                if isinstance(value, Exception):
                    raise value
                return value
        for sub, value in ROUTES:
            if sub in url:
                return value
        raise AssertionError(f"unexpected upstream call: {url}")


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    overhead._cache.clear()
    monkeypatch.setattr(overhead, "OWM_KEY", "test-key")
    yield
    overhead._cache.clear()


@pytest.fixture
def up(monkeypatch):
    fake = FakeUpstream()
    monkeypatch.setattr(overhead, "get_json", fake)
    return fake


@pytest.fixture
def client():
    return overhead.app.test_client()


# ---------------------------------------------------------------------- pages
def test_pages_and_static_files(client):
    page = client.get("/")
    assert page.status_code == 200 and b'id="search-form"' in page.data
    for path in ("/static/app.js", "/static/style.css"):
        r = client.get(path)
        assert r.status_code == 200
        r.close()
    assert client.get("/nope").status_code == 404


# ------------------------------------------------------------------------ geo
def test_search_trims_results_and_sends_key(client, up):
    data = client.get("/api/search?q=howrah").get_json()
    assert data[0] == {"name": "Howrah", "state": "West Bengal", "country": "IN", "lat": 22.59, "lon": 88.31}
    assert data[1]["state"] is None
    assert up.params("geo/1.0/direct") == {"q": "howrah", "limit": 5, "appid": "test-key"}


def test_search_short_query_never_calls_upstream(client, up):
    assert client.get("/api/search?q=a").get_json() == []
    assert up.calls == []


def test_reverse_geocode_and_no_match(client, up):
    assert client.get("/api/reverse?lat=22.59&lon=88.31").get_json()["name"] == "Howrah"
    up.fail["geo/1.0/reverse"] = []
    body = client.get("/api/reverse?lat=0&lon=-30").get_json()
    assert body["name"] is None and body["lat"] == 0 and body["lon"] == -30


@pytest.mark.parametrize("url", ["/api/reverse", "/api/reverse?lat=abc&lon=1", "/api/weather",
                                 "/api/weather?lat=1", "/api/weather?lat=1&lon=x"])
def test_bad_coordinates_return_400_without_upstream_calls(client, up, url):
    assert client.get(url).status_code == 400
    assert up.calls == []


@pytest.mark.parametrize("url", ["/api/search?q=howrah", "/api/reverse?lat=1&lon=2", "/api/weather?lat=1&lon=2"])
def test_missing_api_key_gives_clear_error(client, up, monkeypatch, url):
    monkeypatch.setattr(overhead, "OWM_KEY", "")
    r = client.get(url)
    assert r.status_code == 500 and "OPENWEATHER_API_KEY" in r.get_json()["error"]
    assert up.calls == []


# -------------------------------------------------------------------- weather
def test_weather_response_shape(client, up):
    d = client.get("/api/weather?lat=22.59&lon=88.31").get_json()
    assert d["location"] == {"name": "Howrah", "country": "IN", "lat": 22.59, "lon": 88.31,
                             "timezone": 19800, "elevation": 9.0}
    c = d["current"]
    assert (c["temp"], c["id"], c["wind_deg"], c["rain_1h"]) == (31.2, 802, 200, None)
    assert c["sunrise"] < c["sunset"]
    assert len(d["forecast"]) == 40
    assert set(d["forecast"][0]) == {"dt", "temp", "feels", "pop", "id", "desc", "humidity"}
    assert d["air"] == {"aqi": 4, "components": {"pm2_5": 80.1}}
    assert 0 <= d["moon"]["phase"] <= 1
    for source in ("/data/2.5/weather", "/data/2.5/forecast", "air_pollution", "open-meteo"):
        assert up.count(source) == 1


@pytest.mark.parametrize("sent,used", [("imperial", "imperial"), ("metric", "metric"),
                                       ("kelvin", "metric"), ("", "metric")])
def test_units_are_whitelisted(client, up, sent, used):
    assert client.get(f"/api/weather?lat=1&lon=2&units={sent}").get_json()["units"] == used
    assert up.params("/data/2.5/weather")["units"] == used


def test_optional_sources_failing_does_not_break_weather(client, up):
    up.fail["air_pollution"] = requests.ConnectionError("down")
    up.fail["open-meteo"] = requests.Timeout("slow")
    r = client.get("/api/weather?lat=1&lon=2")
    assert r.status_code == 200
    d = r.get_json()
    assert d["air"] is None and d["location"]["elevation"] is None and d["current"]["temp"] == 31.2


def test_polar_and_rain_edge_cases(client, up):
    up.fail["/data/2.5/weather"] = {**CURRENT, "sys": {"country": "NO"}, "rain": {"1h": 2.4}}
    c = client.get("/api/weather?lat=78&lon=15").get_json()["current"]
    assert c["sunrise"] is None and c["sunset"] is None and c["rain_1h"] == 2.4


@pytest.mark.parametrize("failure,status,text", [
    (http_error(401), 401, "API key"),
    (http_error(429), 429, "rate limit"),
    (http_error(404), 404, "No data"),
    (http_error(500), 502, "Couldn't reach"),
    (requests.Timeout("slow"), 504, "too long"),
    (requests.ConnectionError("down"), 502, "Couldn't reach"),
])
@pytest.mark.parametrize("source", ["/data/2.5/weather", "/data/2.5/forecast"])
def test_core_failures_become_friendly_errors(client, up, source, failure, status, text):
    up.fail[source] = failure
    r = client.get("/api/weather?lat=1&lon=2")
    assert r.status_code == status and text in r.get_json()["error"]


# ---------------------------------------------------------------------- space
def test_iss_payload_and_caching(client, up):
    d = client.get("/api/iss").get_json()
    assert (d["lat"], d["lon"], d["altitude_km"], d["visibility"]) == (10.0, 20.0, 420.5, "daylight")
    assert len(d["path"]["past"]) == 10 and len(d["path"]["future"]) == 10
    client.get("/api/iss")
    assert sum(url.endswith("/25544") for url, _ in up.calls) == 1   # position cached
    assert sum(url.endswith("/positions") for url, _ in up.calls) == 2  # past + future, cached


def test_iss_path_failure_keeps_position_but_position_failure_errors(client, up):
    up.fail["/positions"] = requests.ConnectionError("down")
    d = client.get("/api/iss").get_json()
    assert d["lat"] == 10.0 and d["path"] == {"past": [], "future": []}
    overhead._cache.clear()
    up.fail["/25544"] = requests.ConnectionError("down")
    assert client.get("/api/iss").status_code == 502


def test_space_payload_filters_apod_and_caches(client, up):
    client.get("/api/space")
    d = client.get("/api/space").get_json()
    assert d["crew"]["number"] == 2 and d["apod"]["title"] == "A Nebula"
    assert "service_version" not in d["apod"]
    assert up.count("astros") == 1 and up.count("planetary/apod") == 1


def test_space_degrades_when_sources_fail(client, up):
    up.fail["astros"] = requests.ConnectionError("down")
    up.fail["planetary/apod"] = requests.Timeout("slow")
    r = client.get("/api/space")
    d = r.get_json()
    assert r.status_code == 200 and d["crew"] is None and d["apod"] is None and d["moon"]

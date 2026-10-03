"""Unit tests for pure helpers: moon maths, TTL cache and the safe() wrapper."""
import datetime as dt

import pytest

import app as overhead
from app import NEW_MOON_REF, SYNODIC, moon_info


def at(days):
    return NEW_MOON_REF + dt.timedelta(days=days)


@pytest.mark.parametrize("fraction,name", [
    (0.0, "New moon"), (0.125, "Waxing crescent"), (0.25, "First quarter"), (0.375, "Waxing gibbous"),
    (0.5, "Full moon"), (0.625, "Waning gibbous"), (0.75, "Last quarter"), (0.875, "Waning crescent"),
])
def test_phase_names_across_the_cycle(fraction, name):
    assert moon_info(at(SYNODIC * fraction))["name"] == name


def test_illumination_at_key_points():
    assert moon_info(at(0))["illumination"] == pytest.approx(0, abs=1e-3)
    assert moon_info(at(SYNODIC * 0.25))["illumination"] == pytest.approx(0.5, abs=1e-3)
    assert moon_info(at(SYNODIC * 0.5))["illumination"] == pytest.approx(1, abs=1e-3)


def test_phase_repeats_every_cycle_and_defaults_to_now():
    assert moon_info(at(3.0))["phase"] == pytest.approx(moon_info(at(3.0 + SYNODIC * 5))["phase"], abs=1e-3)
    assert 0 <= moon_info()["phase"] < 1


@pytest.mark.parametrize("fraction,first", [(0.3, "next_full"), (0.7, "next_new")])
def test_next_events_are_in_the_future_and_correctly_ordered(fraction, first):
    now = at(SYNODIC * fraction)
    m = moon_info(now)
    full, new = (dt.datetime.fromisoformat(m[k]) for k in ("next_full", "next_new"))
    assert full > now and new > now
    assert (full < new) == (first == "next_full")


def test_cache_hit_expiry_and_independent_keys(monkeypatch):
    overhead._cache.clear()
    clock, calls = [1000.0], []
    monkeypatch.setattr(overhead.time, "time", lambda: clock[0])

    def make(value):
        return lambda: calls.append(value) or value

    assert overhead.cached("k", 10, make("old")) == "old"
    assert overhead.cached("k", 10, make("new")) == "old"      # served from cache
    assert overhead.cached("other", 10, make("x")) == "x"      # separate key
    clock[0] += 11
    assert overhead.cached("k", 10, make("new")) == "new"      # expired, refreshed
    assert calls == ["old", "x", "new"]
    overhead._cache.clear()


def test_safe_swallows_errors():
    def boom():
        raise RuntimeError("x")
    assert overhead.safe(boom) is None
    assert overhead.safe(lambda: 5) == 5

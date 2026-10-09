"""Live PM2.5 from OpenAQ (served from AWS). Falls back to the historical pattern when unavailable."""
from __future__ import annotations

import datetime as dt
import os
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from . import core

API = "https://api.openaq.org/v3"
_CACHE: dict[int, tuple[float, dict | None]] = {}
TTL = 15 * 60
MAX_AGE_H = 3


def _key() -> str | None:
    return os.environ.get("OPENAQ_API_KEY") or None


def station_latest(station: dict) -> dict | None:
    sid = station["id"]
    hit = _CACHE.get(sid)
    if hit and time.time() - hit[0] < TTL:
        return hit[1]
    result = None
    key = _key()
    if key:
        try:
            r = requests.get(f"{API}/locations/{sid}/latest", headers={"X-API-Key": key}, timeout=4)
            if r.ok:
                sensors = set(station.get("pm25_sensors") or [])
                for row in r.json().get("results", []):
                    if sensors and row.get("sensorsId") not in sensors:
                        continue
                    when = dt.datetime.fromisoformat(row["datetime"]["utc"].replace("Z", "+00:00"))
                    age_h = (dt.datetime.now(dt.timezone.utc) - when).total_seconds() / 3600
                    val = row.get("value")
                    if val is not None and 0 < val < 1500 and age_h <= MAX_AGE_H:
                        result = {"pm25": round(float(val)), "at": row["datetime"]["utc"], "age_h": round(age_h, 1)}
                        break
        except (requests.RequestException, KeyError, ValueError):
            result = None
    _CACHE[sid] = (time.time(), result)
    return result


def air_at(lat: float, lon: float) -> dict:
    """Best estimate of PM2.5 right now at a point."""
    hour = core.now_ist().hour
    near = core.nearest_stations(lat, lon, 3)
    with ThreadPoolExecutor(max_workers=3) as pool:
        lives = list(pool.map(lambda t: station_latest(t[1]), near))
    for (d, s), live in zip(near, lives):
        if live and d <= 10:
            return {"pm25": live["pm25"], "source": "live", "station": s["name"], "station_km": round(d, 1),
                    "updated_utc": live["at"], "category": core.category(live["pm25"]),
                    "typical_for_hour": round(core.expected_pm25(lat, lon, hour))}
    typical = core.expected_pm25(lat, lon, hour)
    return {"pm25": round(typical), "source": "typical", "station": near[0][1]["name"],
            "station_km": round(near[0][0], 1), "category": core.category(typical),
            "typical_for_hour": round(typical)}


def all_stations_now() -> list[dict]:
    stations = core.data()["stations"]
    with ThreadPoolExecutor(max_workers=8) as pool:
        lives = list(pool.map(station_latest, stations))
    hour = core.now_ist().hour
    return [{"id": s["id"], "name": s["name"], "zone": s["zone"], "lat": s["lat"], "lon": s["lon"],
             "pm25": (live or {}).get("pm25"), "typical": s["hourly_median"][hour],
             "live": bool(live)} for s, live in zip(stations, lives)]

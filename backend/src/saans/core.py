"""Pure exposure logic shared by the agent tools and the rule-based fallback. No AWS calls here."""
from __future__ import annotations

import datetime as dt
import json
import math
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

from . import translit

IST = ZoneInfo("Asia/Kolkata")
DATA_FILE = Path(__file__).parent / "data" / "delhi_aq.json"
RIDE_SPEED_KMH = 20.0      # average 2-wheeler speed in Delhi traffic (assumption, shown to user)
ROAD_DETOUR = 1.3          # road distance ~1.3x straight-line distance (assumption)
INDOOR_FACTOR = 0.5        # enclosed AC space vs ambient (AC car ratio in Delhi on-road study)


@lru_cache(maxsize=1)
def data() -> dict:
    return json.loads(DATA_FILE.read_text())


def consts() -> dict:
    return data()["constants"]


def now_ist() -> dt.datetime:
    return dt.datetime.now(IST)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def cigarettes(ugm3_hours: float) -> float:
    return ugm3_hours / consts()["cig_ugm3_hours"]


def category(pm25: float) -> dict:
    """CPCB AQI bands for PM2.5, with Hindi labels."""
    bands = [(30, "Good", "अच्छी"), (60, "Satisfactory", "ठीक"), (90, "Moderate", "मध्यम"),
             (120, "Poor", "खराब"), (250, "Very Poor", "बहुत खराब"), (10 ** 9, "Severe", "गंभीर")]
    for limit, en, hi in bands:
        if pm25 <= limit:
            return {"en": en, "hi": hi}
    return {"en": "Severe", "hi": "गंभीर"}


# ----------------------------------------------------------------------------- places

def _norm(s: str) -> str:
    return translit.phonetic(s)


@lru_cache(maxsize=1)
def gazetteer() -> list[dict]:
    d = data()
    places = [{"name": b["name"], "lat": b["lat"], "lon": b["lon"], "kind": "metro"} for b in d.get("breaks", [])]
    for s in d["stations"]:
        places.append({"name": s["name"].split(",")[0].split(" - ")[0].strip(), "lat": s["lat"],
                       "lon": s["lon"], "kind": "monitor"})
    for z in d["zones"]:
        places.append({"name": z["name"], "lat": z["lat"], "lon": z["lon"], "kind": "zone"})
    for p in places:
        p["key"] = _norm(p["name"])
    return [p for p in places if p["key"]]


def find_place(name: str) -> dict | None:
    """Fuzzy-match a place name in English or Devanagari ('anand vihar', 'आनंद विहार') to coordinates."""
    q = _norm(name)
    if not q:
        return None
    best, best_score = None, 0.0
    for p in gazetteer():
        if q == p["key"]:
            score = 1.0
        elif (q in p["key"] or p["key"] in q) and min(len(q), len(p["key"])) >= 4:
            score = 0.85 + 0.15 * min(len(q), len(p["key"])) / max(len(q), len(p["key"]))
        else:
            score = translit.similarity(q, p["key"])
        if score > best_score:
            best, best_score = p, score
    if best is None or best_score < 0.72:
        return None
    return {"name": best["name"], "lat": best["lat"], "lon": best["lon"], "match": round(best_score, 2)}


def places_in_text(text: str) -> list[dict]:
    """Known places mentioned in free Hindi/Hinglish/English text, in order of appearance."""
    gz = gazetteer()
    hits = translit.find_in_text(text, [p["key"] for p in gz])
    return [{"name": gz[ki]["name"], "lat": gz[ki]["lat"], "lon": gz[ki]["lon"]} for _, _, ki, _ in hits]


# ----------------------------------------------------------------------------- air

def nearest_stations(lat: float, lon: float, k: int = 3) -> list[tuple[float, dict]]:
    return sorted(((haversine_km(lat, lon, s["lat"], s["lon"]), s) for s in data()["stations"]),
                  key=lambda t: t[0])[:k]


def expected_pm25(lat: float, lon: float, hour: int) -> float:
    """Typical PM2.5 at this place and hour of day (inverse-distance weighted median of nearest monitors)."""
    pts = nearest_stations(lat, lon, 3)
    w = [1 / max(d, 0.5) ** 2 for d, _ in pts]
    return sum(wi * s["hourly_median"][hour % 24] for wi, (_, s) in zip(w, pts)) / sum(w)


def zone_of(lat: float, lon: float) -> str:
    return nearest_stations(lat, lon, 1)[0][1]["zone"]


# ----------------------------------------------------------------------------- dose

def trip(from_lat: float, from_lon: float, to_lat: float, to_lon: float,
         depart_hour: int | None = None, live_pm25: float | None = None) -> dict:
    """Dose for one ride, plus the best departure time in the next 6 hours."""
    c = consts()
    km = haversine_km(from_lat, from_lon, to_lat, to_lon) * ROAD_DETOUR
    minutes = max(5, round(km / RIDE_SPEED_KMH * 60))
    hour = now_ist().hour if depart_hour is None else int(depart_hour) % 24
    mid_lat, mid_lon = (from_lat + to_lat) / 2, (from_lon + to_lon) / 2

    def ride_pm(h: int) -> float:
        return (expected_pm25(from_lat, from_lon, h) + expected_pm25(mid_lat, mid_lon, h)
                + expected_pm25(to_lat, to_lon, h)) / 3

    typical_now = ride_pm(hour)
    ambient_now = live_pm25 if live_pm25 else typical_now
    onroad = ambient_now * c["onroad_factor"]
    dose_cigs = cigarettes(onroad * minutes / 60)

    # Compare departure hours over the next 6 hours using the historical pattern (scaled to today's level)
    scale = ambient_now / typical_now if typical_now else 1.0
    options = []
    for dh in range(0, 7):
        h = (hour + dh) % 24
        pm = ride_pm(h) * scale
        options.append({"hour": h, "pm25": round(pm), "cigarettes": round(cigarettes(pm * c["onroad_factor"] * minutes / 60), 3)})
    best = min(options, key=lambda o: o["pm25"])
    saving = 0.0 if options[0]["pm25"] == 0 else (1 - best["pm25"] / options[0]["pm25"]) * 100
    return {
        "distance_km": round(km, 1), "minutes": minutes, "depart_hour": hour,
        "ambient_pm25": round(ambient_now), "onroad_pm25": round(onroad),
        "cigarettes": round(dose_cigs, 2), "category": category(ambient_now),
        "times_who": round(onroad / c["who_24h"], 1),
        "best_departure": best, "saving_pct_if_wait": round(saving),
        "options": options, "used_live_data": bool(live_pm25),
    }


def timing(lat: float, lon: float, live_pm25: float | None = None, minutes: int = 30) -> dict:
    """Which of the next 6 hours has the cleanest air at this place."""
    c = consts()
    hour = now_ist().hour
    typical_now = expected_pm25(lat, lon, hour)
    scale = (live_pm25 / typical_now) if (live_pm25 and typical_now) else 1.0
    options = []
    for dh in range(0, 7):
        h = (hour + dh) % 24
        pm = expected_pm25(lat, lon, h) * scale
        options.append({"hour": h, "pm25": round(pm),
                        "cigarettes": round(cigarettes(pm * c["onroad_factor"] * minutes / 60), 3)})
    best = min(options, key=lambda o: o["pm25"])
    saving = 0 if not options[0]["pm25"] else round((1 - best["pm25"] / options[0]["pm25"]) * 100)
    return {"now_hour": hour, "options": options, "best": best, "saving_pct": saving}


def shift_dose(lat: float, lon: float, start_hour: int, hours_done: float, live_pm25: float | None = None) -> dict:
    """Dose so far in today's shift at this location."""
    c = consts()
    total = 0.0
    full = int(hours_done)
    for i in range(full):
        total += expected_pm25(lat, lon, start_hour + i)
    total += (hours_done - full) * expected_pm25(lat, lon, start_hour + full)
    if live_pm25 and hours_done > 0:
        typ = expected_pm25(lat, lon, now_ist().hour)
        if typ:
            total *= live_pm25 / typ
    return {"hours": round(hours_done, 1), "cigarettes": round(cigarettes(total * c["onroad_factor"]), 2)}


def clean_breaks(lat: float, lon: float, k: int = 3) -> list[dict]:
    spots = sorted(((haversine_km(lat, lon, b["lat"], b["lon"]), b) for b in data().get("breaks", [])),
                   key=lambda t: t[0])[:k]
    out = []
    for d, b in spots:
        out.append({"name": b["name"], "lat": b["lat"], "lon": b["lon"], "km": round(d, 1),
                    "minutes": max(1, round(d * ROAD_DETOUR / RIDE_SPEED_KMH * 60)),
                    "maps": f"https://www.google.com/maps/dir/?api=1&destination={b['lat']},{b['lon']}&travelmode=two-wheeler"})
    return out


def break_benefit(pm25: float, minutes: int = 20) -> dict:
    """How much dose a break indoors saves vs. staying on the road for the same time."""
    c = consts()
    road = cigarettes(pm25 * c["onroad_factor"] * minutes / 60)
    indoor = cigarettes(pm25 * INDOOR_FACTOR * minutes / 60)
    return {"minutes": minutes, "saved_cigarettes": round(road - indoor, 3),
            "saved_pct": round((1 - INDOOR_FACTOR / c["onroad_factor"]) * 100)}

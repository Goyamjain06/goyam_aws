"""
Saans data pipeline.

Builds data/delhi_aq.json from real public data:
  1. Delhi NCR PM2.5 monitors   -> OpenAQ API v3 (needs a free OpenAQ API key)
  2. Hourly PM2.5 history       -> OpenAQ archive on AWS Open Data (s3://openaq-data-archive,
                                   public, no AWS account needed)
  3. Clean-air break spots      -> Delhi NCR metro stations from OpenStreetMap (Overpass API)

Then computes what a delivery rider actually breathes, hour by hour and zone by zone.

Usage (from repo root):
    pip install -r analysis/requirements.txt
    export OPENAQ_API_KEY=xxxxx
    python analysis/build_dataset.py                       # default: 15 Oct - 15 Dec 2025
    python analysis/build_dataset.py --start 2025-11-01 --end 2025-11-30

Output is copied to app/public/data/ and backend/src/saans/data/ automatically.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import io
import json
import math
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
import pandas as pd
import requests
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "delhi_aq.json"
COPIES = [ROOT / "app" / "public" / "data" / "delhi_aq.json",
          ROOT / "backend" / "src" / "saans" / "data" / "delhi_aq.json"]

# Delhi NCR bounding box: Gurugram/Faridabad (south-west) to Ghaziabad/Noida (east)
BBOX = (76.84, 28.38, 77.55, 28.90)  # min lon, min lat, max lon, max lat
OPENAQ_API = "https://api.openaq.org/v3"
BUCKET = "openaq-data-archive"
PM25_PARAMETER_ID = 2

# --- Exposure model constants (every number has a source; see docs/METHOD.md) ---
ONROAD_FACTOR = 1.3      # 2-wheeler on-road PM2.5 ~30% above nearby ambient monitor (Delhi on-road study, Atmos. Env. 2015)
CIG_UGM3_HOURS = 22 * 24  # Berkeley Earth: 22 ug/m3 of PM2.5 for 24 h ~ 1 cigarette  -> 528 ug/m3*h per cigarette
WHO_24H = 15
NAAQS_24H = 60
SHIFT_HOURS = 10
CP = (28.6315, 77.2167)  # Connaught Place, used to split Delhi into zones


# ----------------------------------------------------------------------------- helpers

def log(msg: str) -> None:
    print(f"[saans] {msg}", flush=True)


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def zone_for(name: str, lat: float, lon: float) -> str:
    n = name.lower()
    for key, zone in (("noida", "Noida"), ("greater noida", "Noida"), ("gurugram", "Gurugram"),
                      ("gurgaon", "Gurugram"), ("ghaziabad", "Ghaziabad"), ("faridabad", "Faridabad")):
        if key in n:
            return zone
    # Fallback for NCR stations whose names don't carry the city
    if lon > 77.30 and lat < 28.64:
        return "Noida"
    if lon > 77.33 and lat >= 28.64:
        return "Ghaziabad"
    if lon < 77.10 and lat < 28.52:
        return "Gurugram"
    if lat < 28.45 and lon > 77.25:
        return "Faridabad"
    # Inside Delhi: split around Connaught Place
    if lat > CP[0] + 0.06:
        return "North Delhi"
    if lat < CP[0] - 0.07:
        return "South Delhi"
    if lon > CP[1] + 0.05:
        return "East Delhi"
    if lon < CP[1] - 0.07:
        return "West Delhi"
    return "Central Delhi"


def r1(x):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), 1)


# ----------------------------------------------------------------------------- 1. stations

def discover_stations(api_key: str, min_last: dt.date) -> list[dict]:
    headers = {"X-API-Key": api_key, "Accept": "application/json"}
    stations, page = [], 1
    while True:
        params = {"bbox": ",".join(map(str, BBOX)), "parameters_id": PM25_PARAMETER_ID,
                  "limit": 1000, "page": page}
        resp = requests.get(f"{OPENAQ_API}/locations", headers=headers, params=params, timeout=60)
        if resp.status_code == 401:
            sys.exit("OpenAQ rejected the API key (401). Check OPENAQ_API_KEY.")
        resp.raise_for_status()
        results = resp.json().get("results", [])
        for loc in results:
            if loc.get("isMobile"):
                continue
            last = ((loc.get("datetimeLast") or {}).get("utc") or "")[:10]
            if not last or dt.date.fromisoformat(last) < min_last:
                continue
            pm_sensors = [s["id"] for s in loc.get("sensors", [])
                          if (s.get("parameter") or {}).get("id") == PM25_PARAMETER_ID]
            if not pm_sensors:
                continue
            c = loc.get("coordinates") or {}
            stations.append({
                "id": loc["id"], "name": loc.get("name") or f"Station {loc['id']}",
                "lat": c.get("latitude"), "lon": c.get("longitude"),
                "provider": (loc.get("provider") or {}).get("name"),
                "is_monitor": bool(loc.get("isMonitor")),
                "pm25_sensors": pm_sensors,
            })
        if len(results) < 1000:
            break
        page += 1
    # Prefer reference-grade monitors (CPCB/DPCC/IMD); fall back to everything if too few
    monitors = [s for s in stations if s["is_monitor"]]
    chosen = monitors if len(monitors) >= 8 else stations
    log(f"found {len(stations)} PM2.5 locations in Delhi NCR, using {len(chosen)} "
        f"({'reference monitors' if chosen is monitors else 'all sensors'})")
    return chosen


# ----------------------------------------------------------------------------- 2. history from AWS

def s3_client():
    return boto3.client("s3", region_name="us-east-1", config=Config(signature_version=UNSIGNED,
                                                                     max_pool_connections=48))


def fetch_day(s3, loc_id: int, day: dt.date) -> pd.DataFrame | None:
    key = (f"records/csv.gz/locationid={loc_id}/year={day.year}/month={day.month:02d}/"
           f"location-{loc_id}-{day:%Y%m%d}.csv.gz")
    for attempt in range(3):
        try:
            body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
            df = pd.read_csv(io.BytesIO(gzip.decompress(body)))
            return df
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "AccessDenied"):
                return None
            time.sleep(1 + attempt)
        except Exception:
            time.sleep(1 + attempt)
    return None


def fetch_history(stations: list[dict], start: dt.date, end: dt.date) -> pd.DataFrame:
    s3 = s3_client()
    days = [start + dt.timedelta(d) for d in range((end - start).days + 1)]
    jobs = [(s["id"], d) for s in stations for d in days]
    log(f"downloading {len(jobs)} station-days from s3://{BUCKET} (public AWS Open Data)...")
    frames, done = [], 0
    with ThreadPoolExecutor(max_workers=32) as pool:
        futures = {pool.submit(fetch_day, s3, lid, d): (lid, d) for lid, d in jobs}
        for fut in as_completed(futures):
            done += 1
            df = fut.result()
            if df is not None and len(df):
                frames.append(df)
            if done % 250 == 0:
                log(f"  {done}/{len(jobs)} files checked, {len(frames)} with data")
    if not frames:
        sys.exit("No archive files found for these stations/dates. Try a different --start/--end.")
    raw = pd.concat(frames, ignore_index=True)
    raw.columns = [c.strip().lower() for c in raw.columns]
    need = {"location_id", "datetime", "parameter", "value"}
    if not need.issubset(raw.columns):
        sys.exit(f"Unexpected archive columns: {list(raw.columns)}")
    raw = raw[raw["parameter"].astype(str).str.lower().isin(["pm25", "pm2.5"])]
    raw["value"] = pd.to_numeric(raw["value"], errors="coerce")
    raw = raw[(raw["value"] > 0) & (raw["value"] < 1500)]  # drop sensor errors
    raw["ts"] = pd.to_datetime(raw["datetime"], utc=True, errors="coerce").dt.tz_convert("Asia/Kolkata")
    raw = raw.dropna(subset=["ts"])
    raw["hour_ts"] = raw["ts"].dt.floor("h")
    hourly = (raw.groupby(["location_id", "hour_ts"], as_index=False)["value"].mean())
    hourly["hour"] = hourly["hour_ts"].dt.hour
    hourly["date"] = hourly["hour_ts"].dt.date
    log(f"got {len(hourly):,} station-hours of PM2.5 from {hourly['location_id'].nunique()} stations")
    return hourly


# ----------------------------------------------------------------------------- 3. break spots

OVERPASS_MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)


def fetch_metro_stations() -> list[dict]:
    s, w, n, e = BBOX[1], BBOX[0], BBOX[3], BBOX[2]
    query = f"""[out:json][timeout:120];
    (
      node["railway"="station"]["station"="subway"]({s},{w},{n},{e});
      node["railway"="station"]["subway"="yes"]({s},{w},{n},{e});
      node["public_transport"="station"]["subway"="yes"]({s},{w},{n},{e});
      node["railway"="station"]["network"~"Delhi Metro|Rapid Metro|Noida Metro",i]({s},{w},{n},{e});
    );
    out body;"""
    for url in OVERPASS_MIRRORS:
        for attempt in range(2):
            try:
                resp = requests.post(url, data={"data": query}, timeout=180,
                                     headers={"User-Agent": "saans-hackathon/1.0 (github.com/Goyamjain06/goyam_aws)"})
                if resp.status_code in (429, 504):
                    log(f"overpass busy at {url} ({resp.status_code}), retrying...")
                    time.sleep(10)
                    continue
                resp.raise_for_status()
                seen, spots = set(), []
                for el in resp.json().get("elements", []):
                    tags = el.get("tags") or {}
                    name = tags.get("name:en") or tags.get("name")
                    if not name or "lat" not in el:
                        continue
                    key = name.lower().replace("metro station", "").replace("metro", "").strip()
                    if key in seen:
                        continue
                    seen.add(key)
                    spots.append({"name": name, "lat": round(el["lat"], 5), "lon": round(el["lon"], 5), "type": "metro"})
                if spots:
                    log(f"found {len(spots)} metro stations from OpenStreetMap ({url})")
                    return spots
                log(f"overpass returned no stations at {url}")
                break
            except Exception as ex:  # try again / next mirror
                log(f"overpass error at {url}: {ex}")
                time.sleep(3)
    log("WARNING: could not fetch metro stations; break-spot feature will be empty")
    return []


def compute_siting(station_out: list[dict], breaks: list[dict]) -> list[dict]:
    """Rank metro stations by street-level smoke around them during working hours (9am-9pm)."""
    work = list(range(9, 21))
    siting = []
    for b in breaks:
        pts = sorted(((haversine_km(b["lat"], b["lon"], s["lat"], s["lon"]), s) for s in station_out),
                     key=lambda t: t[0])[:3]
        if not pts or pts[0][0] > 8:
            continue
        wsum = sum(1 / max(d, 0.5) ** 2 for d, _ in pts)
        pm = sum((1 / max(d, 0.5) ** 2) * (sum(s["hourly_median"][x] for x in work) / len(work))
                 for d, s in pts) / wsum
        siting.append({"name": b["name"], "lat": b["lat"], "lon": b["lon"],
                       "work_hours_pm25": r1(pm),
                       "rider_cigs_per_shift": round(cigs(pm * ONROAD_FACTOR * SHIFT_HOURS), 2),
                       "zone": pts[0][1]["zone"]})
    siting.sort(key=lambda x: -x["work_hours_pm25"])
    return siting[:40]


# ----------------------------------------------------------------------------- 4. analysis

def cigs(ugm3_hours: float) -> float:
    return ugm3_hours / CIG_UGM3_HOURS


def build(stations, hourly, breaks, start, end) -> dict:
    by_id = {s["id"]: s for s in stations}
    station_out = []
    for lid, g in hourly.groupby("location_id"):
        s = by_id.get(int(lid))
        if s is None or g["hour_ts"].nunique() < 24 * 7:  # need at least a week of data
            continue
        hmed = g.groupby("hour")["value"].median().reindex(range(24))
        hp90 = g.groupby("hour")["value"].quantile(0.9).reindex(range(24))
        hmed = hmed.interpolate(limit_direction="both")
        hp90 = hp90.interpolate(limit_direction="both")
        daily = g.groupby("date")["value"].mean()
        station_out.append({
            "id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"],
            "provider": s["provider"], "zone": zone_for(s["name"], s["lat"], s["lon"]),
            "pm25_sensors": s.get("pm25_sensors", []),
            "hours_of_data": int(g["hour_ts"].nunique()),
            "mean": r1(g["value"].mean()),
            "hourly_median": [r1(v) for v in hmed], "hourly_p90": [r1(v) for v in hp90],
            "days_over_naaqs": int((daily > NAAQS_24H).sum()), "days": int(len(daily)),
        })
    if len(station_out) < 3:
        sys.exit("Too few stations with a week of data. Widen the date range.")
    ok_ids = {s["id"] for s in station_out}
    h = hourly[hourly["location_id"].isin(ok_ids)].copy()
    h["zone"] = h["location_id"].map({s["id"]: s["zone"] for s in station_out})

    city_hourly = h.groupby("hour")["value"].median().reindex(range(24)).interpolate(limit_direction="both")
    zones = []
    for z, g in h.groupby("zone"):
        members = [s for s in station_out if s["zone"] == z]
        zh = g.groupby("hour")["value"].median().reindex(range(24)).interpolate(limit_direction="both")
        zones.append({
            "name": z, "stations": [s["id"] for s in members],
            "lat": round(sum(s["lat"] for s in members) / len(members), 4),
            "lon": round(sum(s["lon"] for s in members) / len(members), 4),
            "hourly_median": [r1(v) for v in zh], "mean": r1(g["value"].mean()),
        })
    zones.sort(key=lambda z: -z["mean"])

    # Rider shift exposure for every possible 10-hour shift start
    shifts = []
    for start_h in range(24):
        hours = [(start_h + i) % 24 for i in range(SHIFT_HOURS)]
        dose = sum(city_hourly[x] * ONROAD_FACTOR for x in hours)
        shifts.append({"start": start_h, "cigarettes": round(cigs(dose), 2)})
    best = min(shifts, key=lambda s: s["cigarettes"])
    worst = max(shifts, key=lambda s: s["cigarettes"])
    typical = next(s for s in shifts if s["start"] == 10)  # 10am-8pm, a common delivery shift

    # "Red hours": worst 4-hour window of the day (the pollution version of Amazon's 1-4 PM heat rule)
    windows = []
    for s_h in range(24):
        hrs = [(s_h + i) % 24 for i in range(4)]
        windows.append((float(sum(city_hourly[x] for x in hrs) / 4), s_h))
    red_avg, red_start = max(windows)
    clean_avg, clean_start = min(windows)

    daily_city = h.groupby("date")["value"].mean()
    station_hours = h["value"]

    siting = compute_siting(station_out, breaks)

    return {
        "meta": {
            "sample": False,
            "source": "OpenAQ archive on AWS Open Data (s3://openaq-data-archive); station list via OpenAQ API v3; "
                      "metro stations from OpenStreetMap",
            "period": {"start": start.isoformat(), "end": end.isoformat()},
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "stations": len(station_out), "station_hours": int(len(h)), "timezone": "Asia/Kolkata",
        },
        "constants": {"onroad_factor": ONROAD_FACTOR, "cig_ugm3_hours": CIG_UGM3_HOURS,
                      "who_24h": WHO_24H, "naaqs_24h": NAAQS_24H, "shift_hours": SHIFT_HOURS},
        "headline": {
            "city_mean_pm25": r1(station_hours.mean()),
            "times_who": r1(station_hours.mean() / WHO_24H),
            "pct_hours_over_naaqs": r1((station_hours > NAAQS_24H).mean() * 100),
            "pct_days_over_naaqs": r1((daily_city > NAAQS_24H).mean() * 100),
            "typical_shift": typical, "best_shift": best, "worst_shift": worst,
            "best_vs_worst_saving_pct": r1((1 - best["cigarettes"] / worst["cigarettes"]) * 100),
            "red_hours": {"start": red_start, "end": (red_start + 4) % 24, "avg_pm25": r1(red_avg)},
            "clean_hours": {"start": clean_start, "end": (clean_start + 4) % 24, "avg_pm25": r1(clean_avg)},
            "worst_zone": zones[0]["name"], "cleanest_zone": zones[-1]["name"],
        },
        "city_hourly_median": [r1(v) for v in city_hourly],
        "shifts": shifts,
        "daily_city_mean": [{"date": d.isoformat(), "pm25": r1(v)} for d, v in daily_city.items()],
        "zones": zones,
        "stations": station_out,
        "breaks": breaks,
        "siting": siting,
    }


def write(data: dict) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    for c in COPIES:
        c.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(OUT, c)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default="2025-10-15")
    ap.add_argument("--end", default="2025-12-15")
    ap.add_argument("--metro-only", action="store_true",
                    help="only (re)fetch metro stations and rank rest-point sites in the existing data file")
    args = ap.parse_args()
    if args.metro_only:
        data = json.loads(OUT.read_text())
        breaks = fetch_metro_stations()
        if not breaks:
            sys.exit("Still no metro stations. Check your internet and try again in a few minutes.")
        data["breaks"] = breaks
        data["siting"] = compute_siting(data["stations"], breaks)
        write(data)
        log(f"added {len(breaks)} break spots and {len(data['siting'])} ranked rest-point sites")
        log("top 5: " + "; ".join(f"{x['name']} ({x['zone']}, {x['rider_cigs_per_shift']} cig/shift)"
                                  for x in data["siting"][:5]))
        return
    start, end = dt.date.fromisoformat(args.start), dt.date.fromisoformat(args.end)

    key = os.environ.get("OPENAQ_API_KEY")  # only needed for a full build
    if not key:
        sys.exit("Set OPENAQ_API_KEY first (free key from https://explore.openaq.org -> account settings).")

    stations = discover_stations(key, min_last=start)
    hourly = fetch_history(stations, start, end)
    breaks = fetch_metro_stations()
    data = build(stations, hourly, breaks, start, end)

    write(data)
    hd = data["headline"]
    log(f"wrote {OUT.relative_to(ROOT)} (+ copies for app and backend)")
    log("---- headline findings ----")
    log(f"Average PM2.5: {hd['city_mean_pm25']} ug/m3 = {hd['times_who']}x the WHO limit")
    log(f"Hours above India's own limit (60): {hd['pct_hours_over_naaqs']}%")
    log(f"Typical 10am-8pm rider shift = {hd['typical_shift']['cigarettes']} cigarettes/day")
    log(f"Best shift start {hd['best_shift']['start']}:00 = {hd['best_shift']['cigarettes']} cig; "
        f"worst {hd['worst_shift']['start']}:00 = {hd['worst_shift']['cigarettes']} cig "
        f"({hd['best_vs_worst_saving_pct']}% less)")
    log(f"Red hours: {hd['red_hours']['start']}:00-{hd['red_hours']['end']}:00 "
        f"(avg {hd['red_hours']['avg_pm25']} ug/m3)")
    log(f"Worst zone: {hd['worst_zone']}, cleanest: {hd['cleanest_zone']}")


if __name__ == "__main__":
    main()

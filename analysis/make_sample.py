"""
Generates a SYNTHETIC sample dataset (meta.sample = true) so the app can be developed
and tested before the real OpenAQ data is pulled. Station names say "Sample" on purpose.
The app shows a red "SAMPLE DATA" banner and deploy.sh refuses to ship it.

    python analysis/make_sample.py
"""
import datetime as dt
import json
import math
import random
import shutil

import pandas as pd

import build_dataset as b

random.seed(7)
ZONE_CENTRES = {
    "North Delhi": (28.72, 77.19), "South Delhi": (28.53, 77.21), "East Delhi": (28.64, 77.30),
    "West Delhi": (28.65, 77.09), "Central Delhi": (28.63, 77.22), "Noida": (28.57, 77.35),
    "Gurugram": (28.46, 77.04), "Ghaziabad": (28.67, 77.42), "Faridabad": (28.41, 77.31),
}
ZONE_LEVEL = {"East Delhi": 1.25, "Ghaziabad": 1.2, "North Delhi": 1.1, "Central Delhi": 1.0,
              "West Delhi": 1.0, "Noida": 0.95, "Faridabad": 0.95, "South Delhi": 0.9, "Gurugram": 0.85}

stations, rows = [], []
start, end = dt.date(2025, 10, 15), dt.date(2025, 12, 15)
sid = 900000
for zone, (lat, lon) in ZONE_CENTRES.items():
    for k in range(2):
        sid += 1
        s = {"id": sid, "name": f"Sample station {sid - 900000} ({zone})",
             "lat": lat + random.uniform(-0.03, 0.03), "lon": lon + random.uniform(-0.03, 0.03),
             "provider": "SYNTHETIC", "is_monitor": True, "pm25_sensors": [1]}
        stations.append(s)
        day = start
        while day <= end:
            season = 0.7 + 0.6 * math.sin(math.pi * (day - start).days / (end - start).days)
            for h in range(24):
                diurnal = 1.0 + 0.45 * math.cos(2 * math.pi * (h - 23) / 24) - 0.25 * math.exp(-((h - 15) ** 2) / 8)
                v = 120 * season * diurnal * ZONE_LEVEL[zone] * random.uniform(0.75, 1.25)
                ts = pd.Timestamp(day.isoformat(), tz="Asia/Kolkata") + pd.Timedelta(hours=h)
                rows.append({"location_id": sid, "hour_ts": ts, "value": v, "hour": h, "date": day})
            day += dt.timedelta(1)

breaks = [{"name": f"Sample metro {i + 1}", "lat": la + random.uniform(-0.02, 0.02),
           "lon": lo + random.uniform(-0.02, 0.02), "type": "metro"}
          for i, (la, lo) in enumerate(list(ZONE_CENTRES.values()) * 3)]

data = b.build(stations, pd.DataFrame(rows), breaks, start, end)
data["meta"]["sample"] = True
data["meta"]["source"] = "SYNTHETIC SAMPLE - run analysis/build_dataset.py for real data"
b.OUT.parent.mkdir(parents=True, exist_ok=True)
b.OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
for c in b.COPIES:
    c.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(b.OUT, c)
print("wrote SAMPLE dataset:", json.dumps(data["headline"], indent=1))

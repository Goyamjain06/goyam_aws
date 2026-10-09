"""
Rule-based answer used when Bedrock is unavailable (no internet at the venue, quota, etc.).
Same tools, same numbers, template Hindi. The demo never dies.
"""
from __future__ import annotations

import re

from . import core, live
from .hindi import cig_hi, hour_hi

BREAK_WORDS = ("saaf", "साफ", "break", "brake", "aaram", "आराम", "rest", "ruk", "रुक", "ashray", "आश्रय",
               "metro", "मेट्रो", "kahan", "कहाँ", "kaha")
TIME_WORDS = ("kab", "कब", "time", "samay", "समय", "nikl", "निकल")
DOSE_WORDS = ("aaj", "आज", "dose", "kitna", "कितना", "kitni", "cigarette", "सिगरेट", "shift")


def _has(text: str, words) -> bool:
    t = text.lower()
    return any(w in t for w in words)


def answer(text: str, ctx: dict) -> dict:
    lat, lon = ctx["lat"], ctx["lon"]
    cards: dict = {}
    places = core.places_in_text(text)
    air = live.air_at(lat, lon)
    cards["air"] = air
    parts: list[str] = []

    if len(places) >= 2 or (len(places) == 1 and re.search(r"\b(jaa|ja|जा|tak|तक|pahunch|deliver)", text.lower())):
        a, b = (places[0], places[1]) if len(places) >= 2 else ({"name": "आपकी जगह", "lat": lat, "lon": lon}, places[0])
        live_pm = air["pm25"] if air["source"] == "live" else None
        t = core.trip(a["lat"], a["lon"], b["lat"], b["lon"], live_pm25=live_pm)
        t.update({"from": a["name"], "to": b["name"]})
        cards["trip"] = t
        parts.append(f"{a['name']} से {b['name']} तक करीब {t['minutes']} मिनट लगेंगे, "
                     f"इसमें आप {cig_hi(t['cigarettes'])} जितना धुआँ साँस में लेंगे।")
        if t["saving_pct_if_wait"] >= 15 and t["best_departure"]["hour"] != t["depart_hour"]:
            parts.append(f"अगर {hour_hi(t['best_departure']['hour'])} निकलें तो {t['saving_pct_if_wait']}% कम धुआँ लगेगा।")
        else:
            parts.append("अभी निकलना ठीक है, मास्क ज़रूर पहनें।")
        cards["breaks"] = core.clean_breaks(b["lat"], b["lon"], 2)
    elif _has(text, DOSE_WORDS):
        hours = max(0.0, min(14.0, core.now_ist().hour + core.now_ist().minute / 60 - ctx["shift_start"]))
        s = core.shift_dose(lat, lon, ctx["shift_start"], hours, air["pm25"] if air["source"] == "live" else None)
        cards["shift"] = s
        parts.append(f"आपकी शिफ़्ट {hour_hi(ctx['shift_start'])} शुरू होगी, अभी तक का धुआँ गिना नहीं गया।"
                     if s["hours"] <= 0 else f"आज की शिफ़्ट में अब तक आपने {cig_hi(s['cigarettes'])} जितना धुआँ लिया है।")
        bb = core.break_benefit(air["pm25"])
        parts.append(f"20 मिनट किसी बंद, ठंडी जगह पर रुकने से उस समय का {bb['saved_pct']}% धुआँ बचेगा।")
        cards["breaks"] = core.clean_breaks(lat, lon, 2)
    elif _has(text, TIME_WORDS):
        tm = core.timing(lat, lon, air["pm25"] if air["source"] == "live" else None)
        b = tm["best"]
        if b["hour"] != tm["now_hour"] and tm["saving_pct"] >= 10:
            parts.append(f"अगले 6 घंटों में {hour_hi(b['hour'])} हवा सबसे साफ़ रहती है, "
                         f"अभी से {tm['saving_pct']}% कम धुआँ।")
        else:
            parts.append("अगले कुछ घंटों में हवा ऐसी ही रहेगी, अभी निकलना ठीक है।")
        cards["timing"] = tm
    else:
        spots = core.clean_breaks(lat, lon, 3)
        cards["breaks"] = spots
        if spots:
            sp = spots[0]
            parts.append(f"सबसे पास साफ़ हवा वाली जगह {sp['name']} है, करीब {sp['minutes']} मिनट दूर।")
            parts.append("मेट्रो स्टेशन के अंदर सड़क से कम धुआँ होता है, वहाँ थोड़ा आराम कर लें।")

    lead = f"अभी हवा {air['category']['hi']} है, PM2.5 {air['pm25']}।"
    return {"reply": " ".join([lead] + parts), "cards": cards, "engine": "rules"}

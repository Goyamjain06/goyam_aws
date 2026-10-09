"""
Rule-based answer used when Bedrock is unavailable (no internet at the venue, quota, etc.).
Same tools, same numbers, template replies in Hindi or English. The demo never dies.
"""
from __future__ import annotations

import re

from . import core, live
from .hindi import cig_label, hour_label

TIME_WORDS = ("kab", "कब", "time", "samay", "समय", "nikl", "निकल", "when", "leave")
DOSE_WORDS = ("aaj", "आज", "dose", "kitna", "कितना", "kitni", "cigarette", "सिगरेट", "shift", "today", "how much")
GOING = re.compile(r"\b(jaa|ja|tak|pahunch|deliver|going|go to|reach|to)\b|जा|तक", re.I)

T = {
    "hi": {
        "here": "आपकी जगह",
        "trip": "{a} से {b} तक करीब {m} मिनट लगेंगे, इसमें आप {c} जितना धुआँ साँस में लेंगे।",
        "wait": "अगर {h} निकलें तो {p}% कम धुआँ लगेगा।",
        "go_now": "अभी निकलना ठीक है, मास्क ज़रूर पहनें।",
        "not_started": "आपकी शिफ़्ट {h} शुरू होगी, अभी तक का धुआँ गिना नहीं गया।",
        "dose": "आज की शिफ़्ट में अब तक आपने {c} जितना धुआँ लिया है।",
        "break_tip": "20 मिनट किसी बंद, ठंडी जगह पर रुकने से उस समय का {p}% धुआँ बचेगा।",
        "best_time": "अगले 6 घंटों में {h} हवा सबसे साफ़ रहती है, अभी से {p}% कम धुआँ।",
        "same": "अगले कुछ घंटों में हवा ऐसी ही रहेगी, अभी निकलना ठीक है।",
        "spot": "सबसे पास साफ़ हवा वाली जगह {n} है, करीब {m} मिनट दूर।",
        "spot_tip": "मेट्रो स्टेशन के अंदर सड़क से कम धुआँ होता है, वहाँ थोड़ा आराम कर लें।",
        "lead": "अभी हवा {cat} है, PM2.5 {pm}।",
    },
    "en": {
        "here": "your location",
        "trip": "{a} to {b} takes about {m} minutes, and you will breathe {c} worth of smoke.",
        "wait": "Leave at {h} and you will breathe {p}% less smoke.",
        "go_now": "Leaving now is fine. Wear a mask.",
        "not_started": "Your shift starts at {h}, so nothing is counted yet.",
        "dose": "So far in today's shift you have breathed {c} worth of smoke.",
        "break_tip": "A 20-minute break somewhere enclosed and cool saves {p}% of the smoke for that time.",
        "best_time": "In the next 6 hours the air is cleanest at {h}, {p}% less smoke than now.",
        "same": "The air will stay about the same for the next few hours, so leaving now is fine.",
        "spot": "The nearest clean-air spot is {n}, about {m} minutes away.",
        "spot_tip": "Inside a metro station there is less smoke than on the road. Take a short rest there.",
        "lead": "The air is {cat} right now, PM2.5 {pm}.",
    },
}


def _has(text: str, words) -> bool:
    t = text.lower()
    return any(w in t for w in words)


def answer(text: str, ctx: dict) -> dict:
    lang = "en" if ctx.get("lang") == "en" else "hi"
    s_ = T[lang]
    lat, lon = ctx["lat"], ctx["lon"]
    cards: dict = {}
    places = core.places_in_text(text)
    air = live.air_at(lat, lon)
    live_pm = air["pm25"] if air["source"] == "live" else None
    cards["air"] = air
    parts: list[str] = []

    if len(places) >= 2 or (len(places) == 1 and GOING.search(text)):
        a, b = (places[0], places[1]) if len(places) >= 2 else ({"name": s_["here"], "lat": lat, "lon": lon}, places[0])
        t = core.trip(a["lat"], a["lon"], b["lat"], b["lon"], live_pm25=live_pm)
        t.update({"from": a["name"], "to": b["name"]})
        cards["trip"] = t
        parts.append(s_["trip"].format(a=a["name"], b=b["name"], m=t["minutes"], c=cig_label(t["cigarettes"], lang)))
        if t["saving_pct_if_wait"] >= 15 and t["best_departure"]["hour"] != t["depart_hour"]:
            parts.append(s_["wait"].format(h=hour_label(t["best_departure"]["hour"], lang), p=t["saving_pct_if_wait"]))
        else:
            parts.append(s_["go_now"])
        cards["breaks"] = core.clean_breaks(b["lat"], b["lon"], 2)
    elif _has(text, DOSE_WORDS):
        now = core.now_ist()
        hours = max(0.0, min(14.0, now.hour + now.minute / 60 - ctx["shift_start"]))
        sd = core.shift_dose(lat, lon, ctx["shift_start"], hours, live_pm)
        cards["shift"] = sd
        parts.append(s_["not_started"].format(h=hour_label(ctx["shift_start"], lang)) if sd["hours"] <= 0
                     else s_["dose"].format(c=cig_label(sd["cigarettes"], lang)))
        parts.append(s_["break_tip"].format(p=core.break_benefit(air["pm25"])["saved_pct"]))
        cards["breaks"] = core.clean_breaks(lat, lon, 2)
    elif _has(text, TIME_WORDS):
        tm = core.timing(lat, lon, live_pm)
        b = tm["best"]
        if b["hour"] != tm["now_hour"] and tm["saving_pct"] >= 10:
            parts.append(s_["best_time"].format(h=hour_label(b["hour"], lang), p=tm["saving_pct"]))
        else:
            parts.append(s_["same"])
        cards["timing"] = tm
    else:
        spots = core.clean_breaks(lat, lon, 3)
        cards["breaks"] = spots
        if spots:
            parts.append(s_["spot"].format(n=spots[0]["name"], m=spots[0]["minutes"]))
            parts.append(s_["spot_tip"])

    cat = air["category"]["en"].lower() if lang == "en" else air["category"]["hi"]
    lead = s_["lead"].format(cat=cat, pm=air["pm25"])
    return {"reply": " ".join([lead] + parts), "cards": cards, "engine": "rules", "lang": lang}

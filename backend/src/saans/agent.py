"""
Saans agent: Strands Agents SDK (AWS open source) + Amazon Nova on Amazon Bedrock.

The model never invents numbers. Every figure comes from a tool backed by real monitor data.
Tool results are also returned to the app as "cards" so the UI can draw them.
"""
from __future__ import annotations

import os

from strands import Agent, tool
from strands.models import BedrockModel

from . import core, live
from .hindi import hour_label

MODEL_ID = os.environ.get("MODEL_ID", "us.amazon.nova-pro-v1:0")
REGION = os.environ.get("BEDROCK_REGION") or os.environ.get("AWS_REGION", "us-east-1")

SYSTEM_PROMPT = """You are "Saans", a voice assistant for two-wheeler delivery riders in Delhi NCR.
Riders talk to you in Hindi or Hinglish while working. Air pollution is their invisible occupational hazard.

RULES
- {language_rule}
- At most 3 short sentences. No markdown, no lists, no emojis. It will be read aloud.
- NEVER invent numbers. Every number must come from a tool result. Always call a tool first.
- Express pollution as cigarettes; riders understand that better than micrograms.
- Always end with ONE concrete action: a better time to leave, the nearest clean-air break spot, or wearing a mask.
- If a place is not found, say so and ask for a nearby landmark or metro station.
- "here"/"यहाँ"/"मेरी जगह" means the rider's current location: pass an empty string as the place.

TOOLS
- ride_exposure: smoke dose of a ride between two places, and whether leaving later would help.
- air_now: PM2.5 right now at a place.
- clean_break_spots: nearest metro stations (enclosed, less smoke) to rest.
- best_time_here: cleanest hour in the next 6 hours at a place.
- my_shift_dose: how much smoke the rider has breathed in today's shift so far.
"""

LANG_RULES = {
    "hi": "Reply in simple spoken Hindi written in Devanagari (e.g. \"लगभग 0.4 सिगरेट जितना धुआँ\"). "
          "Place names may stay in English.",
    "en": "Reply in simple spoken English (Indian English is fine), whatever language the rider used.",
}

_model: BedrockModel | None = None


def model() -> BedrockModel:
    global _model
    if _model is None:
        from botocore.config import Config
        _model = BedrockModel(model_id=MODEL_ID, region_name=REGION, temperature=0.2,
                              max_tokens=400, streaming=False,
                              boto_client_config=Config(connect_timeout=5, read_timeout=20,
                                                        retries={"max_attempts": 2, "mode": "standard"}))
    return _model


def _resolve(place: str, ctx: dict) -> dict | None:
    if not place or place.strip().lower() in ("here", "yahan", "यहाँ", "यहां", "current", "meri jagah", "मेरी जगह"):
        return {"name": "your location" if ctx.get("lang") == "en" else "आपकी जगह", "lat": ctx["lat"], "lon": ctx["lon"]}
    return core.find_place(place)


def build_tools(ctx: dict) -> list:
    cards = ctx["cards"]

    def not_found(name: str) -> dict:
        return {"error": f"place '{name}' not found", "hint": "ask the rider for a nearby metro station or landmark"}

    @tool
    def ride_exposure(from_place: str, to_place: str, depart_hour: int = -1) -> dict:
        """Smoke dose (in cigarettes) for a two-wheeler ride and the cleanest departure hour in the next 6 hours.

        Args:
            from_place: start place name, e.g. "Anand Vihar". Empty string = rider's current location.
            to_place: destination place name, e.g. "Noida Sector 62".
            depart_hour: hour of day 0-23 in IST. -1 means now.
        """
        a, b = _resolve(from_place, ctx), _resolve(to_place, ctx)
        if not a:
            return not_found(from_place)
        if not b:
            return not_found(to_place)
        air = live.air_at(a["lat"], a["lon"])
        t = core.trip(a["lat"], a["lon"], b["lat"], b["lon"],
                      depart_hour=None if depart_hour < 0 else depart_hour,
                      live_pm25=air["pm25"] if air["source"] == "live" else None)
        t.update({"from": a["name"], "to": b["name"],
                  "best_departure_label": hour_label(t["best_departure"]["hour"], ctx.get("lang", "hi"))})
        cards["trip"] = t
        cards.setdefault("air", air)
        cards["breaks"] = core.clean_breaks(b["lat"], b["lon"], 2)
        return {k: t[k] for k in ("from", "to", "minutes", "distance_km", "cigarettes", "onroad_pm25",
                                  "times_who", "category", "best_departure", "best_departure_label",
                                  "saving_pct_if_wait", "used_live_data")}

    @tool
    def air_now(place: str = "") -> dict:
        """PM2.5 right now at a place (live monitor if available, otherwise the typical value for this hour).

        Args:
            place: place name. Empty string = rider's current location.
        """
        p = _resolve(place, ctx)
        if not p:
            return not_found(place)
        air = live.air_at(p["lat"], p["lon"])
        air["place"] = p["name"]
        cards["air"] = air
        return air

    @tool
    def clean_break_spots(place: str = "") -> dict:
        """Nearest metro stations to rest in (enclosed spaces have less smoke than the road).

        Args:
            place: place name. Empty string = rider's current location.
        """
        p = _resolve(place, ctx)
        if not p:
            return not_found(place)
        spots = core.clean_breaks(p["lat"], p["lon"], 3)
        air = live.air_at(p["lat"], p["lon"])
        cards["breaks"] = spots
        cards.setdefault("air", air)
        return {"spots": [{"name": s["name"], "minutes_away": s["minutes"]} for s in spots],
                "twenty_min_break_saves": core.break_benefit(air["pm25"])}

    @tool
    def best_time_here(place: str = "") -> dict:
        """Cleanest hour to be on the road in the next 6 hours at a place.

        Args:
            place: place name. Empty string = rider's current location.
        """
        p = _resolve(place, ctx)
        if not p:
            return not_found(place)
        air = live.air_at(p["lat"], p["lon"])
        tm = core.timing(p["lat"], p["lon"], air["pm25"] if air["source"] == "live" else None)
        tm["best_label"] = hour_label(tm["best"]["hour"], ctx.get("lang", "hi"))
        cards["timing"] = tm
        cards.setdefault("air", air)
        return tm

    @tool
    def my_shift_dose() -> dict:
        """How much smoke (in cigarettes) the rider has breathed in today's shift so far."""
        now = core.now_ist()
        hours = max(0.0, min(14.0, now.hour + now.minute / 60 - ctx["shift_start"]))
        air = live.air_at(ctx["lat"], ctx["lon"])
        s = core.shift_dose(ctx["lat"], ctx["lon"], ctx["shift_start"], hours,
                            air["pm25"] if air["source"] == "live" else None)
        s["shift_start_label"] = hour_label(ctx["shift_start"], ctx.get("lang", "hi"))
        cards["shift"] = s
        cards.setdefault("air", air)
        return s

    return [ride_exposure, air_now, clean_break_spots, best_time_here, my_shift_dose]


def answer(text: str, ctx: dict) -> dict:
    ctx.setdefault("cards", {})
    now = core.now_ist()
    lang = "en" if ctx.get("lang") == "en" else "hi"
    rule = (LANG_RULES[lang])
    agent = Agent(model=model(), tools=build_tools(ctx), callback_handler=None,
                  system_prompt=SYSTEM_PROMPT.replace("{language_rule}", rule)
                  + f"\nCurrent time in Delhi: {now:%H:%M} ({hour_label(now.hour, lang)}).")
    result = agent(text)
    reply = str(result).strip()
    if not ctx["cards"].get("air"):
        ctx["cards"]["air"] = live.air_at(ctx["lat"], ctx["lon"])
    return {"reply": reply, "cards": ctx["cards"], "engine": f"strands+{MODEL_ID}", "lang": lang}

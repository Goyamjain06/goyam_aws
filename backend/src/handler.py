"""AWS Lambda entry point (Lambda Function URL)."""
from __future__ import annotations

import base64
import json
import time
import traceback

from saans import aws, core, fallback, live

DELHI_DEFAULT = (28.7499, 77.1170)  # DTU, Delhi


def _resp(status: int, body: dict) -> dict:
    return {"statusCode": status, "headers": {"content-type": "application/json; charset=utf-8"},
            "body": json.dumps(body, ensure_ascii=False, default=str)}


def _body(event: dict) -> dict:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _ctx(b: dict) -> dict:
    lat, lon = b.get("lat"), b.get("lon")
    try:
        lat, lon = float(lat), float(lon)
        if core.haversine_km(lat, lon, *DELHI_DEFAULT) > 80:  # outside NCR -> demo at DTU
            lat, lon = DELHI_DEFAULT
    except (TypeError, ValueError):
        lat, lon = DELHI_DEFAULT
    return {"lat": lat, "lon": lon, "shift_start": int(b.get("shift_start") or 9),
            "rider_id": str(b.get("rider_id") or "")[:64], "cards": {},
            "lang": "en" if b.get("lang") == "en" else "hi"}


def ask(b: dict) -> dict:
    text = str(b.get("text") or "").strip()[:500]
    if not text:
        return _resp(400, {"error": "text is required"})
    ctx = _ctx(b)
    started = time.time()
    try:
        from saans import agent  # imported lazily so the fallback still works if Strands fails to load
        out = agent.answer(text, ctx)
    except Exception:
        traceback.print_exc()
        ctx["cards"] = {}
        out = fallback.answer(text, ctx)
    out["ms"] = int((time.time() - started) * 1000)
    if out["cards"].get("trip"):
        aws.log_trip(ctx["rider_id"], out["cards"]["trip"])
    if b.get("speak", True):
        out["audio_mp3_b64"] = aws.speak(out["reply"], ctx["lang"])
    out["today"] = aws.rider_today(ctx["rider_id"])
    return _resp(200, out)


def lambda_handler(event, _context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")
    qs = event.get("queryStringParameters") or {}
    try:
        if path == "/health":
            m = core.data()["meta"]
            return _resp(200, {"ok": True, "sample_data": m.get("sample"), "period": m.get("period"),
                               "stations": m.get("stations")})
        if path == "/ask" and method == "POST":
            return ask(_body(event))
        if path == "/speak" and method == "POST":
            b = _body(event)
            return _resp(200, {"audio_mp3_b64": aws.speak(str(b.get("text", ""))[:1500], "en" if b.get("lang") == "en" else "hi")})
        if path == "/live":
            if qs.get("all"):
                return _resp(200, {"stations": live.all_stations_now()})
            c = _ctx(qs)
            return _resp(200, live.air_at(c["lat"], c["lon"]))
        if path == "/rider":
            return _resp(200, aws.rider_today(str(qs.get("rider_id", ""))[:64]))
        return _resp(404, {"error": "not found"})
    except Exception as e:
        traceback.print_exc()
        return _resp(500, {"error": str(e)})

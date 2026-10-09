"""Amazon Polly (Hindi voice) and DynamoDB (rider trip log)."""
from __future__ import annotations

import base64
import datetime as dt
import os
from decimal import Decimal

import boto3

from . import core

_polly = None
_table = None


def speak(text: str) -> str | None:
    """Hindi speech as base64 MP3 using Amazon Polly's neural Hindi voice (Kajal)."""
    global _polly
    try:
        _polly = _polly or boto3.client("polly")
        out = _polly.synthesize_speech(Text=text[:1500], OutputFormat="mp3", VoiceId="Kajal",
                                       Engine="neural", LanguageCode="hi-IN")
        return base64.b64encode(out["AudioStream"].read()).decode()
    except Exception as e:  # never break the answer because of audio
        print(f"polly error: {e}")
        return None


def table():
    global _table
    name = os.environ.get("TABLE_NAME")
    if not name:
        return None
    _table = _table or boto3.resource("dynamodb").Table(name)
    return _table


def log_trip(rider_id: str, trip: dict) -> None:
    t = table()
    if not t or not rider_id:
        return
    now = core.now_ist()
    try:
        t.put_item(Item={
            "rider_id": rider_id, "ts": now.isoformat(timespec="seconds"),
            "from": trip.get("from", ""), "to": trip.get("to", ""),
            "minutes": int(trip["minutes"]), "cigarettes": Decimal(str(trip["cigarettes"])),
            "onroad_pm25": int(trip["onroad_pm25"]),
            "expires": int((dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=30)).timestamp()),
        })
    except Exception as e:
        print(f"dynamodb error: {e}")


def rider_today(rider_id: str) -> dict:
    t = table()
    if not t or not rider_id:
        return {"trips": [], "cigarettes": 0}
    from boto3.dynamodb.conditions import Key
    today = core.now_ist().date().isoformat()
    try:
        items = t.query(KeyConditionExpression=Key("rider_id").eq(rider_id) & Key("ts").begins_with(today))["Items"]
    except Exception as e:
        print(f"dynamodb error: {e}")
        items = []
    trips = [{"ts": i["ts"], "from": i.get("from"), "to": i.get("to"), "minutes": int(i["minutes"]),
              "cigarettes": float(i["cigarettes"])} for i in items]
    return {"trips": trips, "cigarettes": round(sum(x["cigarettes"] for x in trips), 2)}

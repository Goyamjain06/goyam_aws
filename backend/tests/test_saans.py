import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from saans import core, fallback, live  # noqa: E402

DTU = (28.7499, 77.1170)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.delenv("OPENAQ_API_KEY", raising=False)
    monkeypatch.delenv("TABLE_NAME", raising=False)
    live._CACHE.clear()


def test_data_loads():
    d = core.data()
    assert d["stations"] and d["zones"] and len(d["city_hourly_median"]) == 24


def test_cigarette_math():
    # Berkeley Earth: 22 ug/m3 for 24 hours = 1 cigarette
    assert core.cigarettes(22 * 24) == pytest.approx(1.0)


def test_categories():
    assert core.category(25)["en"] == "Good"
    assert core.category(300)["hi"] == "गंभीर"


def test_trip_is_sane():
    a, b = core.data()["stations"][0], core.data()["stations"][-1]
    t = core.trip(a["lat"], a["lon"], b["lat"], b["lon"], depart_hour=18)
    assert t["minutes"] >= 5 and t["cigarettes"] > 0
    assert t["onroad_pm25"] == round(t["ambient_pm25"] * 1.3) or abs(t["onroad_pm25"] - t["ambient_pm25"] * 1.3) <= 1
    assert len(t["options"]) == 7 and t["saving_pct_if_wait"] >= 0


def test_find_place_fuzzy():
    z = core.data()["zones"][0]["name"]
    p = core.find_place(z.lower())
    assert p and p["name"] == z
    assert core.find_place("zzzz qqqq") is None


def test_breaks_sorted():
    spots = core.clean_breaks(*DTU, 3)
    assert spots == sorted(spots, key=lambda s: s["km"])


def test_air_without_key_uses_typical():
    a = live.air_at(*DTU)
    assert a["source"] == "typical" and a["pm25"] > 0


@pytest.mark.parametrize("text,card", [
    ("East Delhi se Gurugram jaa raha hoon", "trip"),
    ("aaj kitna dhuaan liya", "shift"),
    ("kab niklu", "timing"),
    ("paas mein saaf hawa kahan hai", "breaks"),
])
def test_fallback_intents(text, card):
    ctx = {"lat": DTU[0], "lon": DTU[1], "shift_start": 9, "rider_id": "t", "cards": {}}
    out = fallback.answer(text, ctx)
    assert card in out["cards"], out
    assert "PM2.5" in out["reply"]


def test_handler_falls_back_when_bedrock_unavailable(monkeypatch):
    import handler
    from saans import agent

    def boom(*a, **k):
        raise RuntimeError("no bedrock")

    monkeypatch.setattr(agent, "answer", boom)
    monkeypatch.setattr(handler.aws, "speak", lambda t: None)
    ev = {"requestContext": {"http": {"method": "POST"}}, "rawPath": "/ask",
          "body": json.dumps({"text": "paas mein saaf hawa kahan hai", "lat": DTU[0], "lon": DTU[1]})}
    r = handler.lambda_handler(ev, None)
    body = json.loads(r["body"])
    assert r["statusCode"] == 200 and body["engine"] == "rules" and body["reply"]


def test_agent_tools_produce_cards():
    from saans import agent
    ctx = {"lat": DTU[0], "lon": DTU[1], "shift_start": 9, "rider_id": "t", "cards": {}}
    tools = {t.tool_name: t for t in agent.build_tools(ctx)}
    z = core.data()["zones"]
    out = tools["ride_exposure"](from_place="", to_place=z[0]["name"])
    assert "cigarettes" in out and "trip" in ctx["cards"]
    assert "error" in tools["air_now"](place="nowhere-xyz")
    tools["my_shift_dose"]()
    assert "shift" in ctx["cards"]

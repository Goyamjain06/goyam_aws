"""
Ask the agent from your terminal, using your own AWS login. Good for testing Bedrock before deploying.

    cd backend && pip install -r requirements.txt
    python local.py "आनंद विहार से नोएडा सेक्टर 62 जा रहा हूँ"
    python local.py --rules "paas mein saaf hawa kahan hai"     # rule-based fallback, no AWS needed
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))
from saans import fallback  # noqa: E402

args = sys.argv[1:]
use_rules = "--rules" in args
text = " ".join(a for a in args if a != "--rules") or "पास में साफ़ हवा कहाँ है?"
ctx = {"lat": 28.7499, "lon": 77.1170, "shift_start": 9, "rider_id": "local", "cards": {}}
if use_rules:
    out = fallback.answer(text, ctx)
else:
    from saans import agent
    out = agent.answer(text, ctx)
print(out["reply"])
print("\nengine:", out["engine"], "| cards:", ", ".join(out["cards"]))
print(json.dumps(out["cards"].get("trip") or out["cards"].get("air"), ensure_ascii=False, indent=1)[:800])

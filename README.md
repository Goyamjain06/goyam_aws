# Saans (साँस): smog dose for delivery riders

**Team Edge_testcase, Environmental Hacks (Bharat Builds Tour, WeMakeDevs x AWS), Air track.**

Delhi's delivery riders spend 8 to 10 hours a day on two-wheelers in the worst air in the world. They breathe
more smoke than the nearest monitor shows, nobody tells them how much, and nobody plans shifts around it.
Amazon already pulls riders off the road from 1 to 4 pm during heatwaves. Smog has no such rule.

Saans turns government monitor data into two things:

- **Rider app (Hindi, voice-first).** A rider says *"आनंद विहार से नोएडा सेक्टर 62 जा रहा हूँ"* and hears back,
  in Hindi, how much smoke the ride costs in cigarettes, whether leaving later would help, and the nearest
  metro station to take a clean-air break. It also tracks the day's dose so far.
- **Station planner.** The pollution version of the heat rule: the worst hours by zone, a roster view that moves
  riders to cleaner shift times (and shows how much smoke that saves), and a ranked list of where new rest points
  would cut the most exposure.

## How it's built on AWS

| Piece | AWS |
|---|---|
| Hindi voice agent | **Strands Agents SDK** (AWS open source) with **Amazon Nova Pro** on **Amazon Bedrock** |
| Spoken replies | **Amazon Polly**, neural Hindi voice (Kajal) |
| API | **AWS Lambda** (Function URL), deployed with **AWS SAM** |
| Rider trip log | **Amazon DynamoDB** |
| Web app | **AWS Amplify Hosting** |
| Air data | **OpenAQ archive on AWS Open Data** (`s3://openaq-data-archive`) + OpenAQ API for live readings |

The agent never makes up numbers. Every figure comes from a tool backed by monitor data
(`backend/src/saans/agent.py`). If Bedrock is unreachable, the same tools answer with Hindi templates, and if the
whole backend is unreachable, the app answers on the phone with the same model, so a demo never dies.

```
rider's voice (hi-IN) ─► Lambda ─► Strands agent ─► Amazon Nova (Bedrock)
                                        │  tools: ride_exposure, air_now, clean_break_spots,
                                        │         best_time_here, my_shift_dose
                                        ├─► OpenAQ live PM2.5 + season pattern (OpenAQ on AWS Open Data)
                                        ├─► DynamoDB (trip log)
                                        └─► Polly (Hindi audio) ─► rider hears the answer
```

## The method (every number has a source)

- **Air:** hourly PM2.5 from government monitors in Delhi NCR, Oct 15 to Dec 15 2025, from the OpenAQ archive
  on AWS. `analysis/build_dataset.py` builds the hour-by-zone pattern, the worst hours, and the best shift times.
- **On-road factor 1.3:** two-wheeler riders in Delhi breathe ~30% more PM2.5 than the nearby ambient monitor
  (Goel et al., *Atmospheric Environment* 2015, on-road exposure study in Delhi).
- **Cigarettes:** 22 µg/m³ of PM2.5 over 24 hours ≈ 1 cigarette (Berkeley Earth). Riders breathe harder than at
  rest, so this is conservative.
- **Break benefit:** enclosed AC spaces sit at about half the road level in the same Delhi study.
- **Break spots:** metro stations from OpenStreetMap.
- **Limits:** these are estimates from fixed monitors, not personal sensors. Speed (20 km/h) and road distance
  (1.3× straight line) are stated assumptions.

## Run it

```bash
# 1. Real data (no AWS account needed; free OpenAQ key from explore.openaq.org)
pip install -r analysis/requirements.txt
OPENAQ_API_KEY=xxxx python3 analysis/build_dataset.py

# 2. Web app locally (works without the backend)
cd app && npm install && npm run dev        # http://localhost:5173

# 3. Everything on AWS (needs: brew install awscli aws-sam-cli node; aws configure)
OPENAQ_API_KEY=xxxx ./deploy.sh
```

Test the agent from the terminal with your AWS login: `cd backend && pip install -r requirements.txt && python3 local.py "कब निकलूँ?"`.
Backend tests: `cd backend && python3 -m pytest tests`.

## Repo

```
analysis/   data pipeline (OpenAQ on AWS -> data/delhi_aq.json)
backend/    Lambda: Strands agent, tools, fallback, Polly, DynamoDB, SAM template
app/        React + TypeScript web app: /rider, /station, landing page
deploy.sh   one-command deploy (SAM + Amplify)
```

## AI tools used

Built with help from Claude (Anthropic) for research, code and writing, as allowed by the tour rules.

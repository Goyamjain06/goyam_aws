#!/usr/bin/env bash
# One command to put RideClean on AWS:
#   backend  -> AWS SAM: Lambda (Strands agent + Amazon Nova on Bedrock + Polly) + DynamoDB
#   frontend -> AWS Amplify Hosting
#
# Usage:  OPENAQ_API_KEY=xxxx ./deploy.sh
# Optional: AWS_REGION (default us-east-1), MODEL_ID, ALLOW_SAMPLE=1 (deploy with synthetic data)
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK="saans"
APP_NAME="saans"
BRANCH="main"
MODEL_ID="${MODEL_ID:-us.amazon.nova-pro-v1:0}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

say() { printf "\n\033[1m==> %s\033[0m\n" "$*"; }
need() { command -v "$1" >/dev/null || { echo "Missing '$1'. Install with: $2"; exit 1; }; }

need aws "brew install awscli"
need sam "brew install aws-sam-cli"
need node "brew install node"
need python3 "brew install python@3.12"
need zip "it ships with macOS"

say "Checking AWS login"
aws sts get-caller-identity --query Arn --output text || { echo "Run 'aws configure' first."; exit 1; }

if python3 -c "import json,sys; sys.exit(0 if json.load(open('data/delhi_aq.json'))['meta'].get('sample') else 1)" 2>/dev/null; then
  if [[ "${ALLOW_SAMPLE:-0}" != "1" ]]; then
    echo "data/delhi_aq.json is SYNTHETIC sample data. Run: python3 analysis/build_dataset.py"
    echo "(or ALLOW_SAMPLE=1 ./deploy.sh to deploy anyway)"; exit 1
  fi
fi
[[ -z "${OPENAQ_API_KEY:-}" ]] && echo "Note: OPENAQ_API_KEY not set, the app will use typical (not live) air values."

say "Building and deploying the backend (Lambda + DynamoDB) with AWS SAM"
(
  cd backend
  sam build
  sam deploy --stack-name "$STACK" --region "$REGION" --capabilities CAPABILITY_IAM --resolve-s3 \
    --no-confirm-changeset --no-fail-on-empty-changeset \
    --parameter-overrides "OpenAQApiKey=${OPENAQ_API_KEY:-}" "ModelId=$MODEL_ID"
)
API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
API_URL="${API_URL%/}"
echo "API: $API_URL"
curl -fsS "$API_URL/health" && echo

say "Building the web app"
(
  cd app
  echo "VITE_API_URL=$API_URL" > .env.production
  npm ci --silent
  npm run build
  rm -f ../dist.zip && (cd dist && zip -qr ../../dist.zip .)
)

say "Publishing to AWS Amplify Hosting"
APP_ID=$(aws amplify list-apps --query "apps[?name=='$APP_NAME'].appId | [0]" --output text)
if [[ "$APP_ID" == "None" || -z "$APP_ID" ]]; then
  RULES='[{"source":"</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|webmanifest|woff|woff2|ttf|map|json|webp|mp3)$)([^.]+$)/>","target":"/index.html","status":"200"}]'
  APP_ID=$(aws amplify create-app --name "$APP_NAME" --platform WEB --custom-rules "$RULES" --query app.appId --output text)
  aws amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" --stage PRODUCTION >/dev/null
fi
read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --query "[jobId, zipUploadUrl]" --output text)
curl -fsS -H "Content-Type: application/zip" --upload-file dist.zip "$UPLOAD_URL"
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" >/dev/null
for _ in $(seq 1 60); do
  STATUS=$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" --query job.summary.status --output text)
  [[ "$STATUS" == "SUCCEED" ]] && break
  [[ "$STATUS" == "FAILED" || "$STATUS" == "CANCELLED" ]] && { echo "Amplify deployment $STATUS"; exit 1; }
  sleep 5
done
rm -f dist.zip

URL="https://$BRANCH.$APP_ID.amplifyapp.com"
say "Done"
echo "Website:        $URL"
echo "Rider app:      $URL/rider"
echo "Station planner $URL/station"
echo "API:            $API_URL"

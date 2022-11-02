#!/bin/bash

# https://stackoverflow.com/a/67216965
curl_fail_with_body() {
  curl -o - -w "\n%{http_code}\n" "$@" | awk '{l[NR] = $0} END {for (i=1; i<=NR-1; i++) print l[i]}; END{ if ($0<200||$0>299) exit 1 }'
}

if [ -z "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" ]; then
  echo "ACTIONS_ID_TOKEN_REQUEST_TOKEN is not available."
  echo "Have you added the following?"
  echo "permissions:"
  echo "  id-token: write"
  exit 1
fi

echo "Getting token from Github"
if ! BODY=$(curl_fail_with_body -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL" --silent); then
  echo "Failed to get token from Github"
  echo "$BODY"
  exit 1
fi

TOKEN=$(echo "$BODY" | jq -r -e '.value?')
if [[ "$TOKEN" = "null" || -z "$TOKEN" ]]; then
  echo "Failed to get token from Github"
  echo "$BODY"
  exit 1
fi

echo "Deploying new version"

if ! FASIT_BODY=$(curl_fail_with_body -H "Authorization:Bearer $TOKEN" "$ENDPOINT/github/deploy/$FEATURE_NAME" -X POST -d "$JSON" --silent); then
  echo "Failed to deploy new version"
  echo "$FASIT_BODY"
  exit 1
fi

if ! ROLLOUT_ID=$(echo "$FASIT_BODY" | jq -r -e '.rollout?'); then
  echo "Failed get rollout id"
  echo "$FASIT_BODY"
  exit 1
fi

echo '### Rollout created! :rocket:' >> "$GITHUB_STEP_SUMMARY"
echo "[Rollout progress](https://fasit.nais.io/rollout/$ROLLOUT_ID)" >> "$GITHUB_STEP_SUMMARY"

echo "Rollout progress: https://fasit.nais.io/rollout/$ROLLOUT_ID"

if error=$(echo "$FASIT_BODY" | jq -r -e '.error?'); then
  echo "Got an error while deploying: $error" | tee -a "$GITHUB_STEP_SUMMARY"
fi

if envNotAvailable=$(echo "$FASIT_BODY" | jq -r -e 'try (.envNotAvailable? | select(length > 0) | "Not enabled in: "+ (. | join(", ")))'); then
  echo "**WARNING**: $envNotAvailable" | tee -a "$GITHUB_STEP_SUMMARY"
fi

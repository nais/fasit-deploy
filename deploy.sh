#!/bin/bash
if [ -z "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" ]; then
  echo "ACTIONS_ID_TOKEN_REQUEST_TOKEN is not available."
  echo "Have you added the following?"
  echo "permissions:"
  echo "  id-token: write"
  exit 1
fi

echo "Getting token from Github"
if ! BODY=$(curl -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL" --silent --fail); then
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


if ! FASIT_BODY=$(curl -H "Authorization:Bearer $TOKEN" "$ENDPOINT/github/deploy/$FEATURE_NAME" -X POST -d "$JSON" --fail --silent); then
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

if ! error=$(echo "$FASIT_BODY" | jq -r -e '.error?'); then
  echo "Got a warning while deploying: $error" | tee -a "$GITHUB_STEP_SUMMARY"
fi

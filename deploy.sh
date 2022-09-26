#!/bin/bash
set -ex
echo "Getting token from Github"
TOKEN=$(curl -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL" --silent | jq -r '.value')
echo "Deploying new version"
ROLLOUT_ID=$(curl -H "Authorization:Bearer $TOKEN" "$ENDPOINT/github/deploy/$FEATURE_NAME" -X POST -d "$JSON" --fail --silent| jq -r '.rollout')
echo "Rollout done with id $ROLLOUT_ID"
echo '### Rollout created! :rocket:' >> "$GITHUB_STEP_SUMMARY"
echo "[Rollout progress](https://fasit.nais.io/rollout/$ROLLOUT_ID)" >> "$GITHUB_STEP_SUMMARY"

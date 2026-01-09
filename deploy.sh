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

FEATURE_NAME=$(echo -n "$(echo "$CHART" | grep -o  '[^/]*$')")

if [ -z "$CHART" ]; then
  echo "chart is not set"
  exit 1
fi

if [ -z "$VERSION" ]; then
  echo "version is not set"
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

TARGET=${TARGET:-"{}"}
GLOBAL=${GLOBAL:-"true"}
REPO_NAME=$(echo "$GITHUB_REPOSITORY" | cut -d'/' -f2)
JSON='{"global": '$GLOBAL',"target": '$TARGET', "chart": "'$CHART'", "version": "'$VERSION'", "ref": {"owner": "'$GITHUB_REPOSITORY_OWNER'", "repo": "'$REPO_NAME'", "ref": "'$GITHUB_SHA'"}}'

if ! FASIT_BODY=$(curl_fail_with_body -H "Authorization:Bearer $TOKEN" "$ENDPOINT/github/deployment" -X POST -d "$JSON" --silent); then
  echo "Failed to deploy new version"
  echo "$FASIT_BODY"
  exit 1
fi

deployment_id=$(echo "$FASIT_BODY" | jq -r '.id')

echo '### Deployment created! :rocket:' >> "$GITHUB_STEP_SUMMARY"
echo "[Deployment progress](https://fasit.nais.io/features/$FEATURE_NAME/deployments/$deployment_id)" >> "$GITHUB_STEP_SUMMARY"

echo "Deployment progress: https://fasit.nais.io/features/$FEATURE_NAME/deployments/$deployment_id"


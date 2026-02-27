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

CHART=$(printf '%s' "$CHART" | tr -d '[:space:]')
VERSION=$(printf '%s' "$VERSION" | tr -d '[:space:]')

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

if [ -z "$TARGET" ] && [ -z "$ALL_ENVS" ]; then
  echo "TARGET and ALL_ENVS not set, resolving target from Helm chart"
  CHART_DIR=$(mktemp -d)
  if ! helm pull "$CHART" --version "$VERSION" --destination "$CHART_DIR" --untar; then
    echo "Failed to download Helm chart $CHART version $VERSION"
    rm -rf "$CHART_DIR"
    exit 1
  fi
  echo "Helm chart extracted to $CHART_DIR"

  FEATURE_FILE="$CHART_DIR/$FEATURE_NAME/Feature.yaml"
  if [ ! -f "$FEATURE_FILE" ]; then
    echo "Feature.yaml not found at $FEATURE_FILE"
    rm -rf "$CHART_DIR"
    exit 1
  fi

  TARGET=$(yq -o=json -I=0 '.target' "$FEATURE_FILE")
  if [ -z "$TARGET" ] || [ "$TARGET" = "null" ]; then
    echo "Either 'all-environments', 'target' action parameter, or 'target' field in Feature.yaml must be set"
    rm -rf "$CHART_DIR"
    exit 1
  fi
  rm -rf "$CHART_DIR"
  echo "Resolved target from chart: $TARGET"
elif [ "$ALL_ENVS" == "true" ] && [ -z "$TARGET" ]; then
  TARGET='{}'
fi


if [ -z "$ALL_ENVS" ] && [ -z "$TARGET" ]; then
  echo "Either all-environments or target must be set"
  exit 1
fi

echo "Deploying new version"

GLOBAL=${GLOBAL:-"true"}
SKIP_CI=${SKIP_CI:-"false"}
WAIT=${WAIT:-"true"}
REPO_NAME=$(echo "$GITHUB_REPOSITORY" | cut -d'/' -f2)
JSON='{"ci": {"skip": '$SKIP_CI', "wait": '$WAIT'}, "global": '$GLOBAL',"target": '$TARGET', "chart": "'$CHART'", "version": "'$VERSION'", "ref": {"owner": "'$GITHUB_REPOSITORY_OWNER'", "repo": "'$REPO_NAME'", "ref": "'$GITHUB_SHA'"}}'
echo "JSON: $JSON"

if ! FASIT_BODY=$(curl_fail_with_body -H "Authorization:Bearer $TOKEN" "$ENDPOINT/github/deployment" -X POST -d "$JSON" --silent); then
  echo "Failed to deploy new version"
  echo "$FASIT_BODY"
  exit 1
fi

echo '### Deployment created! :rocket:' >> "$GITHUB_STEP_SUMMARY"
echo "[Deployment progress](https://fasit.nais.io/deployments)" >> "$GITHUB_STEP_SUMMARY"

echo "Deployment progress: https://fasit.nais.io/deployments"


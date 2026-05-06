# Fasit-deploy action

GitHub Action that creates Fasit deployments for a feature. 

## Requirements

- `runs-on: fasit-deploy` (Fasit is not exposed to the internet; this runner sits on the nais-io private network).
- `permissions: id-token: write` on the job (needed to mint the OIDC token).
- The OCI chart referenced by `chart` must already be pushed to the feature registry at the given `version`.

## Usage

```yaml
jobs:
  deploy:
    needs: [build_push]
    runs-on: fasit-deploy
    permissions:
      id-token: write
    steps:
      - uses: nais/fasit-deploy@v4
        with:
          chart: ${{ env.FEATURE_REPOSITORY }}/${{ env.NAME }}
          version: ${{ needs.build_push.outputs.version }}
          targets: |
            [
              { "target": { "kind": "management", "tenant": "ci-nais" }, "wait": true },
              { "target": { "kind": "management" } }
            ]
```

Or read the targets from a file in the repository:

```yaml
      - uses: nais/fasit-deploy@v4
        with:
          chart: ${{ env.FEATURE_REPOSITORY }}/${{ env.NAME }}
          version: ${{ needs.build_push.outputs.version }}
          targets-file: ./.github/fasit-targets.json
```

`targets` and `targets-file` are mutually exclusive.

## Inputs

| Input             | Required | Default | Description |
| ----------------- | -------- | ------- | ----------- |
| `chart`           | yes      |         | OCI URL to the feature chart, e.g. `oci://europe-north1-docker.pkg.dev/nais-io/nais/feature/myfeature`. |
| `version`         | yes      |         | Chart version to deploy. |
| `targets`         | one of   |         | Inline JSON array of `{target, wait}` entries. |
| `targets-file`    | one of   |         | Path to a JSON file containing the same array. Resolved relative to the workspace, so `actions/checkout` has to run first. |
| `timeout-minutes` | no       | `10`    | Per-target wait timeout. Only relevant for entries with `wait: true`. |

### Target entries

Each entry in the `targets` array is an object:

- `target` (required) — JSON object of label key/value pairs. The deployment matches every Fasit environment whose labels are a superset of this object. `{}` matches all environments.
- `wait` (optional, default `false`) — when `true`, the action polls Fasit every 10 seconds until that deployment reaches a terminal state or the timeout is reached.

The action POSTs the entries sequentially in array order. If any POST fails, or any `wait: true` entry ends in a failed state or times out, the action exits non-zero and does not process the remaining entries.

Look up valid label keys/values in [Fasit](https://fasit.nais.io/labels).

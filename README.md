# Fasit-deploy action

An action that rolls out a new version of a fasit-feature to all environments.

## Usage

```yaml
name: Build and deploy image
jobs:
  rollout:
    needs: [build_push]
    runs-on: fasit-deploy
    permissions:
      id-token: write
    steps:
      - uses: nais/fasit-deploy@v2
        with:
          chart: # OCI Chart URL
          version: # Chart version
```

## How it works

```mermaid
sequenceDiagram
    participant Fasit
    participant Postgres
    participant Naisd
    Fasit->>Postgres: create rollout
    Note right of Postgres: on create - trigger notify
    Postgres->>Fasit: Rollout, start listen for change
    Note left of Fasit: update status and old values
    Fasit->>Postgres: save changes
    Note left of Fasit: update env config for CI environments
    Fasit->>Postgres: save changes
    Note right of Postgres: on update - trigger notify
    Postgres->>Fasit: Reconciler - listen for change
    Note left of Fasit: Reconcile environments, find pending rollouts for configuration
    Fasit->>Naisd: Deploy instructions
    Note right of Naisd: Do deploy
    Naisd->>Fasit: Helm status
    Note left of Fasit: add log to rollout

```

```mermaid
graph
    A[Helm Status] --> B(On Failure)
    A[Helm Status] --> C(On Success)
    B --> D[mark as failed]
    B --> E[Roll back]
    C --> F[Mark as success]
    C --> G[Set as global]

```

Fasit is not exposed to the internet, so the action runs on a github-runner on the private network in nais-io.

The action will authenticate with fasit using an [openIDConnect token](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)

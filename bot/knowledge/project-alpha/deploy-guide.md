# Project Alpha — Deployment Guide

## Overview
Project Alpha is a microservices-based platform deployed on AWS EKS. This guide covers the deployment process for production and staging environments.

## Prerequisites
- AWS CLI configured with `project-alpha-deploy` profile
- kubectl configured for the target cluster
- Docker installed locally
- Access to the internal Docker registry: `registry.company.internal`
- Helm 3.x installed

## Environments
| Environment | Cluster | Namespace | URL |
|-------------|---------|-----------|-----|
| Production  | eks-prod-us-east-1 | alpha-prod | https://alpha.company.com |
| Staging     | eks-staging | alpha-staging | https://alpha-staging.company.com |

## Deployment Steps

### 1. Build & Push Docker Image
```bash
docker build -t registry.company.internal/project-alpha:$VERSION .
docker push registry.company.internal/project-alpha:$VERSION
```

### 2. Deploy to Staging
```bash
helm upgrade --install project-alpha ./helm/project-alpha \
  --namespace alpha-staging \
  --set image.tag=$VERSION \
  --values ./helm/values.staging.yaml
```

### 3. Run Smoke Tests
```bash
kubectl exec -n alpha-staging deployment/project-alpha -- ./scripts/smoke-test.sh
```

### 4. Deploy to Production
After staging verification, deploy to production:
```bash
helm upgrade --install project-alpha ./helm/project-alpha \
  --namespace alpha-prod \
  --set image.tag=$VERSION \
  --values ./helm/values.prod.yaml
```

## Rollback
To rollback to the previous release:
```bash
helm rollback project-alpha -n alpha-prod
```

## Configuration
Environment-specific config is managed via Kubernetes ConfigMaps and Secrets. Never commit secrets to the repository. Use the internal Vault at `vault.company.internal` to manage secrets.

## Monitoring
- Grafana dashboards: https://grafana.company.internal/d/alpha
- Sentry: https://sentry.company.internal/project-alpha
- Alerting: PagerDuty integration configured for P1/P2 incidents

## Contact
For deployment issues, contact the Platform Engineering team in #platform-eng Slack channel.

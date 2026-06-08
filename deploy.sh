#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env — fill secrets, then re-run."
  exit 1
fi

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

docker compose build bot
docker compose build admin
docker compose up -d

echo ""
echo "Admin:   https://${DOMAIN:-$(grep ^DOMAIN= .env | cut -d= -f2)}"
echo "Adminer: https://${DOMAIN:-...}/db"
echo "Slack:   https://${DOMAIN:-...}/slack/events"
echo "Logs:   docker compose logs -f bot"

#!/usr/bin/env bash
# Pull the latest main and (re)build the stack. Run on the VPS from anywhere.
set -euo pipefail
cd /opt/beam
git pull --ff-only
cd deploy
test -f .env || { echo "missing deploy/.env (see deploy/.env.example)"; exit 1; }
# Caddy (public HTTPS) only runs once a domain is configured.
if grep -qE '^DOMAIN=.+' .env; then
  docker compose --profile https up -d --build
else
  docker compose up -d --build
fi
docker compose ps

#!/usr/bin/env bash
# Pull the latest main and (re)build the stacks. Run on the VPS from anywhere.
set -euo pipefail
cd /opt/beam
git pull --ff-only
cd deploy
test -f .env || { echo "missing deploy/.env (see deploy/.env.example)"; exit 1; }

profiles=()
# Public HTTPS once a domain is configured.
if grep -qE '^DOMAIN=.+' .env; then profiles+=(--profile https); fi
# The mainnet stack once its contracts are deployed and a relayer key is set.
if [ -f ../contracts/deployments/mainnet.json ] && grep -qE '^MAINNET_RELAYER_PRIVATE_KEY=0x[0-9a-fA-F]{64}' .env; then
  profiles+=(--profile mainnet)
fi

docker compose "${profiles[@]}" up -d --build
docker compose "${profiles[@]}" ps

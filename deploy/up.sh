#!/usr/bin/env bash
# Pull the latest main and (re)build the stack. Run on the VPS from anywhere.
set -euo pipefail
cd /opt/beam
git pull --ff-only
cd deploy
test -f .env || { echo "missing deploy/.env (see deploy/.env.example)"; exit 1; }
docker compose up -d --build
docker compose ps

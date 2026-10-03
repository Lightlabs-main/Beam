#!/usr/bin/env bash
# Back up both Beam indexer databases. Run from cron on the VPS, for example daily at 03:00 UTC.
set -euo pipefail

cd /opt/beam/deploy
# Compose reads .env for interpolation, while pg_dump receives its database name directly.
# Load the same optional value here so a custom ENVIO_PG_DATABASE is backed up correctly.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
backup_dir=${BACKUP_DIR:-/opt/beam/backups}
mkdir -p "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)

docker compose exec -T postgres pg_dump --format=custom --no-owner --no-acl "${ENVIO_PG_DATABASE:-envio}" > "$backup_dir/testnet-$stamp.dump"
if docker compose --profile mainnet ps -q postgres-mainnet | grep -q .; then
  docker compose --profile mainnet exec -T postgres-mainnet pg_dump --format=custom --no-owner --no-acl "${ENVIO_PG_DATABASE:-envio}" > "$backup_dir/mainnet-$stamp.dump"
fi

# Keep two weeks of local recovery points. Copy the directory to separate storage as well.
find "$backup_dir" -type f -name '*.dump' -mtime +14 -delete
echo "Backups written to $backup_dir ($stamp)"

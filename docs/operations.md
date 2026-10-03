# Beam operations

The production deployment is a single VPS running the testnet and mainnet Compose profiles. The
relayer key, database password, Hasura secret and optional provider credentials stay in
`deploy/.env`; they are never committed.

Run `deploy/backup.sh` from a daily cron job on the VPS. It writes custom-format PostgreSQL dumps
for each running network to `/opt/beam/backups` and keeps fourteen days locally. Copy those dumps to
separate storage. Restore into a stopped replacement database with `pg_restore --clean --if-exists`.

`/healthz` returns 503 when the relayer is below its gas floor or either live feed is disconnected.
Docker health checks use that endpoint, and external monitoring should alert on both HTTP status and
the reported `relayerBalanceWei`.

Before a deploy, run:

```bash
pnpm typecheck
pnpm test
pnpm build
BEAM_NETWORK=testnet pnpm verify
BEAM_NETWORK=mainnet pnpm verify
```

If card funding is configured, set `RAMP_URL` to the provider's hosted URL and include `{address}`
where the viewer wallet should be inserted. When it is unset, the gift page shows the manual Monad
USDC funding instructions instead of pretending a card flow is available.

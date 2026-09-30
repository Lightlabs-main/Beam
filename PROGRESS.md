# Progress

Last updated 2026-09-30.

## Done

- **Contracts** (`contracts/`): BeamGifts (direct gifts, same-transaction splits) and BeamClaims
  (gift-a-chatter, Beam Bomb, reclaim, expiry refund). No admin, no upgrade path.
  47 fork tests pass against Circle's real USDC on both Monad mainnet and testnet.
- **Testnet deployment**: addresses in `contracts/deployments/testnet.json`.
- **First real gasless gift** on Monad testnet from a wallet holding zero MON, relayer paid gas
  (details in `docs/verification.md`).
- **Shared package** (`packages/shared`): ABIs exported from the Forge build, deployment record,
  EIP-3009 gift signing. Tests confirm nonce, USDC domain and signature acceptance on live testnet.
- **Indexer** (`indexer/`): Envio HyperIndex v3 over all BeamGifts and BeamClaims events.
  Config generated from the deployment record. Not yet run (Envio has no Windows build; runs on the VPS).
- **Server** (`server/`): gasless relayer (validate, simulate, submit; minimum gift, per-IP rate
  limit, relayer balance floor) and the indexed gift feed over WebSocket. 8 relayer tests pass
  against live testnet.
- **Overlay** (`web/overlay.html`): alert + confetti, goal bar, recent gifts, QR. Driven only by
  indexed events.
- **Deployment** (`deploy/`): Docker Compose stack (Postgres, Hasura, Envio, server, Caddy HTTPS),
  running on AWS Lightsail (London, static IP 16.61.50.207). Public at https://beamstreams.xyz
  (Let's Encrypt; www redirects). Postgres, Hasura and the server port are not reachable publicly.
- **§3.4 passed**: real gifts reach the overlay over WebSocket in 0.26–0.58 s from the relay request.
  Alerts come from the chain's own log push; Envio (rate-limited on the free token) is the backup
  source and serves history, totals and the recent list (details in `docs/verification.md`).
- **Gift-a-chatter on stream**: drops carry a sender-signed channel; a real chatter gift showed on the
  creator's overlay and was claimed by a fresh account holding no MON (BeamClaims redeployed).

- **Viewer pages** (live): landing page with OBS link builder; gift page `/g/<creator>` (Mera passkey
  wallet, honest funding, gift the streamer or a chatter); claim page `/c/<dropId>`; wallet page
  `/wallet` (balances, recovery phrase, take back unclaimed gifts, forget-device recovery test).
- **Gift-a-chatter via the public API**: drop, claim into a fresh wallet (0 MON), double-claim refused,
  take-back, all live (see verification).
- **Beam Bomb** (live): one 163-character link; first chatters each claim a share; races, double
  claims, latecomers and dust all verified on testnet.
- **Passkey gate (§3.2)**: create + receive verified on a real phone; send + recover pending.

## Next

1. Mera passkey gate (§3.2) on a real phone: create, receive, send, recover. Pages are live; needs the
   user's phone. Record it.
2. Mainnet: relayer/deployer wallet created (`0x19Ec2A9f412A00913341E9F347A84AFa1077F24e`, key in `.env`,
   separate from testnet). Needs MON from the user, then deploy (~0.36 MON at 102 gwei; ~0.019 MON per
   gift). Monad bills the gas limit, not gas used: keep relayer gas limits tight.
3. Splits need a creator dashboard (the creator defines co-stream/mod/charity shares).
4. `script/verify.ts` wired as `pnpm verify` and in CI.

## Blocked / waiting on

- **Ramp** production key application (§3.3): not started by the user yet as far as recorded here.
- **Mainnet MON** for the relayer wallet above (suggested 5 MON: deploy + a few hundred gifts).
- **Passkey gate send + recover** on the user's phone.

## Known gaps

- Bomb fairness: one share per wallet, but passkey wallets are free to make, so a determined person
  can take several shares. Fine for a crowd moment; not a strict one-per-human guarantee.

- **Spec deviation (agreed 2026-09-30)**: §6.1 says alerts are driven by the Envio stream. They are
  driven by the chain log push first, Envio second, because the free HyperSync token stalls realtime
  indexing ~50 s each minute. Revisit if Envio Starter is bought.

- Relayer rate limiting is in-memory per process; fine for one server.
- Free space on the development machine's C: drive keeps dropping; watch it.

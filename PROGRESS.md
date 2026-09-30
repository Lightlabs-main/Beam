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
  VPS bootstrap and deploy scripts.

## Next

1. Bring up the VPS stack; confirm a real gift reaches the overlay through Envio over WebSocket and
   measure chain → overlay latency (§3.4).
2. Mera passkey gate (§3.2): create an account on a real phone, receive and send USDC gaslessly,
   recover on a second device. Record it.
3. Gift page `/g/<creator>`: Mera passkey → amount → sign → relay. The overlay QR already points here.
4. Drops need a committed `channel` (whose stream) so chatter gifts and bombs can be routed to the
   right overlay: contract change + redeploy on testnet.
5. Live testnet runs of splits, claims, reclaims and bombs.
6. `script/verify.ts` wired as `pnpm verify` and in CI.

## Blocked / waiting on

- **VPS**: IP and a domain with an A record pointing at it (HTTPS is required for passkeys).
- **Envio API token** for HyperSync: create at https://envio.dev/app/api-tokens.
- **Ramp** production key application (§3.3): not started by the user yet as far as recorded here.
- **Real phone** for the Mera passkey test.

## Known gaps

- `ChatterGiftSent` and `BombSent` do not say whose stream they belong to, so the overlay only shows
  direct and split gifts today (see Next 4).
- Relayer rate limiting is in-memory per process; fine for one server.
- Free space on the development machine's C: drive keeps dropping; watch it.

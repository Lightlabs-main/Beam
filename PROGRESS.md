# Progress

Last updated 2026-10-03.

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
  Config generated from the deployment record. Runs on the VPS and serves history, totals and wallet activity
  to the public API (Envio has no Windows build).
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
  `/wallet` (balances, recovery phrase, indexed portfolio activity, sent-drop recovery, take-back,
  forget-device recovery test).
- **Gift-a-chatter via the public API**: drop, claim into a fresh wallet (0 MON), double-claim refused,
  take-back, all live (see verification).
- **Beam Bomb** (live): one 163-character link; first chatters each claim a share; races, double
  claims, latecomers and dust all verified on testnet.
- **Passkey gate (§3.2)**: create, receive and send verified on a real phone; recover pending.
- **Beam Studio** `/studio`: camera behind the live overlay, recorded in the browser (no OBS needed for the video).
- **Claims on stream**: the overlay shows when a chatter claims or a bomb share is grabbed.
- **Earnings page** `/earnings?creator=`: balance, total received, latest gifts with the creator's share.
  Fixed: goal totals counted whole split gifts as the creator's; secondary split recipients now see
  their payout in recent history.
- **Watch page** `/watch/<creator>`: the creator's Twitch/YouTube/Kick player, platform chat where
  embeddable, and gifting on one shareable link (stream link is part of the signed settings).
- **Creator dashboard** `/creator`: OBS link, `!gift` command for Nightbot/StreamElements, signed
  settings (name, goal, split shares). **Instant splits** live: one gift paid three wallets in one tx;
  creator-side setup is available in the dashboard.
- **`pnpm verify` + CI** (GitHub Actions): typecheck, live-testnet tests, verify, indexer codegen,
  Forge suite on mainnet and testnet forks. Green.
- **README** (§11).
- **Mainnet live** (2026-10-02): BeamGifts `0xbbDf…d1Db`, BeamClaims `0xF493…bdE2` at https://beamstreams.xyz;
  testnet at https://testnet.beamstreams.xyz. `pnpm verify` passes on both.
- **Definition of done: first real mainnet gift** from a phone passkey wallet holding 0 MON, settled and
  alerted on stream (tx `0x4dd6de12…a5b105`).
- **Guided creator setup** (6 self-ticking steps), one-download OBS scene, Beam Twitch bot with
  channel-ownership proof (Connect with Twitch).
- **Wallet portfolio**: indexed activity API combines direct gifts, split payouts, drops, claims and
  reclaims; the wallet discovers sender drops from chain history after local storage is lost.
- **Alert actions**: gift pages expose confetti, pulse and fireworks styles and the overlay renders
  the signed action code.
- **One-click OBS** (2026-10-03): "Connect OBS" on `/creator` and the home page adds the overlay to the
  live scene over OBS's built-in WebSocket (on top, scaled to the canvas, locked; re-running updates it).
  Password asked only when OBS uses one. Drag-the-link and the scene-file download remain as fallbacks.
- **X streams** (2026-10-03): X is a stream platform in creator settings (username); the watch page links
  out to X for video and chat; setup step 4 gives a pinned-reply post instead of a bot.
- **Operational hardening**: verifier selects the matching testnet/mainnet URL, health checks return
  503 when sponsorship or feeds are unhealthy, security headers are set, Compose health checks and
  database backup runbook are present.

## Next

1. Demo video (recording runbook in docs/); real streamers.
2. Beam Twitch bot: waiting on a Twitch app (2FA blocked the user's account; a teammate can register it).
3. Configure the production on-ramp URL when provider credentials arrive.
4. Optional: TTS and richer creator-defined Gift Actions.

## Blocked / waiting on

- **Ramp** provider credentials: the code supports an optional hosted URL through `RAMP_URL`; the
  provider account and production key are still external prerequisites.
- **Passkey gate recover** on the user's phone (forget device → sign in with the same passkey).

## Known limits

- Bomb fairness: one share per wallet, but passkey wallets are free to make, so a determined person
  can take several shares. Fine for a crowd moment; not a strict one-per-human guarantee.

- **Spec deviation (agreed 2026-09-30)**: §6.1 says alerts are driven by the Envio stream. They are
  driven by the chain log push first, Envio second, because the free HyperSync token stalls realtime
  indexing ~50 s each minute. Revisit if Envio Starter is bought.

- Relayer rate limiting is in-memory per process; fine for one server.
- Free space on the development machine's C: drive keeps dropping; watch it.

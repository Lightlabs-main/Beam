# Beam

Live gifts for streamers that land on screen in under a second, paid straight to the creator on
Monad. A viewer scans the QR on stream, confirms with a passkey, and the gift explodes onto the
video while the USDC is already in the creator's wallet.

**The animation isn't a promise to pay the creator later. The animation is the settlement.**

Live on **Monad mainnet** at **https://beamstreams.xyz**, with a free test-money version at
**https://testnet.beamstreams.xyz**.

## The problem

Live gifting is enormous, and creators keep only part of it. Platform gift systems take a large cut,
impose minimums and multi-week payouts, and decide who is allowed to receive at all. Tip tools bolted
on from outside settle slowly, exclude regions, and can't do anything a bank transfer can't.

## How it works

1. **Scan.** The creator clicks **Connect OBS** (or adds one browser-source URL). Viewers scan its QR code.
2. **Passkey.** The viewer gets a wallet with Face ID, fingerprint or screen lock: no app, no seed
   phrase, no gas token.
3. **Gift.** They pick an amount and a message. Their phone signs a USDC authorization; Beam's
   relayer submits it and pays the network fee.
4. **On stream.** The alert fires from the gift's own on-chain event, about half a second after the
   relay request. The creator already holds the money.

## What's different

Not "crypto tips". Beam is peer-to-peer gifting on a chain fast enough that the animation is the
settlement:

- **Gift a chatter.** Send real money to another viewer who has no wallet. They open a claim link,
  make a passkey wallet, and it's theirs. The crypto version of gift subs.
- **Beam Bomb.** One link in chat; the first N chatters each claim an equal share.
- **Instant splits.** A co-streamer, mod, editor or charity takes a defined share in the same
  transaction (contract live, tested and configurable in the creator dashboard).
- **Gasless passkey onboarding.** Viewers and chatters never hold MON.
- **Sub-second settlement** as the product, not a footnote.

## Why Monad

The gift has to appear on stream while the moment is still happening. Monad's sub-second finality
makes the animation land live, and near-zero fees make a $0.50 gift worth sending. On a slow or
expensive chain neither is true.

## Live addresses

### Monad mainnet (chain 143)

| | Address |
|---|---|
| BeamGifts | [`0xbbDfDCcd88Bfdf28ba51Fc4fC13c9B0a40dfd1Db`](https://monadscan.com/address/0xbbDfDCcd88Bfdf28ba51Fc4fC13c9B0a40dfd1Db) |
| BeamClaims | [`0xF4932F63dD5de62fDd38e11e4c6F7ecc1a63bdE2`](https://monadscan.com/address/0xF4932F63dD5de62fDd38e11e4c6F7ecc1a63bdE2) |
| USDC (Circle) | [`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`](https://monadscan.com/address/0x754704Bc059F8C67012fEd69BC8A327a5aafb603) |

First real gift on mainnet, from a passkey wallet made on a phone, holding zero MON:
[`0x4dd6de12…a5b105`](https://monadscan.com/tx/0x4dd6de125efc97daa4257af7ce84352922c5dbdd12544e052d897d20e8a5b105)

### Monad testnet (chain 10143)

| | Address |
|---|---|
| BeamGifts | [`0x649Cdc9A801a8d7918f28FBB3b178568bcFBF0a7`](https://testnet.monadscan.com/address/0x649Cdc9A801a8d7918f28FBB3b178568bcFBF0a7) |
| BeamClaims | [`0x5f7C6f905f013002b51970D7D0c5b28Ead5d585C`](https://testnet.monadscan.com/address/0x5f7C6f905f013002b51970D7D0c5b28Ead5d585C) |
| USDC (Circle) | [`0x534b2f3A21130d7a60830c2Df862319e593943A3`](https://testnet.monadscan.com/address/0x534b2f3A21130d7a60830c2Df862319e593943A3) |

Real transactions, all from wallets holding zero MON:

- First gasless gift: [`0x56ef2f76…19aa6d`](https://testnet.monadscan.com/tx/0x56ef2f7682f3fd89443bcf5030200fcd137a8b82f05db3ef2d8e56200219aa6d)
- Gift through the public site that fired the overlay: [`0x67754f20…50590b`](https://testnet.monadscan.com/tx/0x67754f209533f2ecb3be0621b95fe21a95c4901d60532d294d4268ca5150590b)
- A chatter's passkey wallet claiming a gift on a real phone: [`0xa35bea19…cbcd3d`](https://testnet.monadscan.com/tx/0xa35bea196e68c12ebf28689df76292ed95a13ea88ce5cf6539146293d4cbcd3d)
- Beam Bomb share claimed by a fresh wallet: [`0xdcc22ca7…3b5d6`](https://testnet.monadscan.com/tx/0xdcc22ca759d17e14b6056160ff37842e95dfb705e476e1e3b587402701e3b5d6)


## Built with

| | Job in Beam |
|---|---|
| **Solidity** (Foundry) | BeamGifts (direct gifts, splits) and BeamClaims (gift-a-chatter, Beam Bomb, take-back). No owner, no admin, no upgrade path. |
| **Mera** (Category Labs) | Passkey wallets: the viewer's front door and the chatter's claim. |
| **USDC** (Circle) | What gets gifted, moved with EIP-3009 authorizations. |
| **Gasless relay** (EIP-3009) | Beam's relayer submits viewers' signed authorizations and pays the gas. |
| **Envio** HyperIndex | Indexes every gift, drop and claim: history, goal totals, recent gifts, and a backup alert feed. |
| **OBS browser source** | The overlay, drawn into the video, so every platform's viewers see it without platform approval. Added in one click over OBS's built-in WebSocket. |
| **Funding** | Manual Monad USDC by default; an optional hosted on-ramp URL is enabled with `RAMP_URL` when provider credentials are available. |

## Architecture

```
Overlay (OBS) · Gift page · Claim page · Wallet page          https://beamstreams.xyz
        │  WebSocket (alerts)            │  HTTPS (relay requests)
┌───────┴────────────────────────────────┴───────────────────────────────┐
│ Beam server (Node/TS)                                                   │
│  relayer: validate → simulate → submit (min gift, rate limit, gas floor)│
│  alerts: Monad log push (eth_subscribe) first, Envio stream as backup,  │
│          de-duplicated by event id                                      │
└───────┬────────────────────────────────┬───────────────────────────────┘
        │ Hasura GraphQL                 │ JSON-RPC / WebSocket
   Envio HyperIndex ── Postgres     Monad: BeamGifts · BeamClaims · USDC
```

Everything runs from one Docker Compose stack (`deploy/`) behind Caddy with automatic HTTPS.

## Verification

Every dependency is proven against live Monad before anything is built on it, and re-checked by
`pnpm verify` in CI: chain id, Circle USDC (version, decimals, EIP-712 domain, EIP-3009), both
contracts and their USDC, browser-side signing against the contracts, HyperSync keeping up, and the
live service (relayer gas floor, feeds, pages). Raw results, latencies and transaction hashes are in
[docs/verification.md](docs/verification.md).

```bash
pnpm install && pnpm verify
cd contracts && forge test                         # fork of Monad mainnet
cd contracts && BEAM_NETWORK=testnet forge test    # fork of Monad testnet
```

## The hard parts

- **Gasless without the viewer holding MON.** The viewer signs an EIP-3009 authorization whose nonce
  is derived on-chain from the recipient, message and every other field, so a relayer that changes
  anything invalidates the signature. The relayer simulates before it sends, so it only pays for
  transactions the chain accepts.
- **Money for someone with no wallet.** A claim link carries a one-time key; the chain stores only a
  Merkle root of key addresses. The key signs the claimer's own address, so a link seen in flight
  can't be redirected. A Beam Bomb's keys all derive from one seed, keeping the chat link short.
- **Real-time alerts without hammering an RPC.** Alerts ride Monad's log push; Envio indexes
  everything and backs it up. The free HyperSync tier is rate-limited in realtime, which is why the
  push path exists (measured in the verification log).
- **Honest funding.** An on-ramp takes minutes. The product says so: fund once, then every gift is
  instant.

## Honest position

Crypto donations for streamers already exist. Beam's edge is the experience and the primitives
together: peer-to-peer gifting to walletless chatters, bombs, same-transaction splits, passkey
onboarding with no gas token, and sub-second settlement that makes the alert and the payment the same
event.

## Risks

- **Relayer gas.** The relayer's MON balance is an operational dependency; it refuses to sponsor
  below a floor, and `pnpm verify` fails if it gets there.
- **Funding latency.** Hosted card funding is optional and provider-dependent; manual USDC funding is always available.
- **Passkey support.** Wallets need a passkey provider with WebAuthn PRF (iCloud Keychain, Google
  Password Manager, 1Password). Wallets are bound to `beamstreams.xyz`; the recovery phrase is the
  backup.
- **Bomb fairness.** One share per wallet, but passkey wallets are free to make.
- **Platforms.** The overlay is a browser source, so it needs no extension review on Twitch, YouTube,
  Kick or X. X live video and chat don't embed reliably, so the watch page links out to X and the
  `!gift` bot is Twitch-only (Nightbot covers YouTube and Kick).

## Roadmap

Richer creator-defined Gift Actions, verified gifter names via Twitch/YouTube connect, supporter badges
and leaderboards from on-chain events, AUSD, mobile-streamer support, and mobile-money top-up for cash
economies.

## Status

Built during Monad Metropolis (Sept 1 – Oct 13, 2026). Live on Monad mainnet; the testnet version stays
up for trying Beam with free test USDC. Progress, next steps and blockers: [PROGRESS.md](PROGRESS.md).

## Repository

| Path | |
|---|---|
| `contracts/` | Solidity contracts and fork tests (Foundry) |
| `indexer/` | Envio HyperIndex |
| `server/` | Relayer, alert feeds, API |
| `web/` | Overlay, landing, gift, claim, wallet portfolio and earnings pages |
| `packages/shared/` | ABIs, deployments, signing and claim-link logic shared by server and web |
| `script/verify.ts` | `pnpm verify` |
| `deploy/` | Docker Compose stack, Caddy, VPS scripts |

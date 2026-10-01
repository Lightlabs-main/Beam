# Verification

What has been checked against real chains, and how to re-check it.

## Circle USDC on Monad

Addresses from [Circle's USDC contract list](https://developers.circle.com/stablecoins/usdc-contract-addresses), confirmed on chain on 2026-09-30:

| Network | Chain ID | USDC | name / symbol | version | decimals |
|---|---|---|---|---|---|
| Mainnet | 143 | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | USDC / USDC | 2 | 6 |
| Testnet | 10143 | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | USDC / USDC | 2 | 6 |

Both answer `authorizationState(address,bytes32)`, the EIP-3009 entry point Beam relies on, and both
revert with FiatToken v2's error strings (asserted exactly in the tests).

```bash
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "version()(string)" --rpc-url https://rpc.monad.xyz
```

## Contract tests

The suite forks live Monad and runs against Circle's deployed USDC; no token is mocked.

```bash
cd contracts && forge test                        # mainnet fork (default)
cd contracts && BEAM_NETWORK=testnet forge test   # testnet fork
```

Result on 2026-09-30 (commit `b02e2a0`): **47 passed, 0 failed** on both networks
(20 BeamGifts, 27 BeamClaims).

## Testnet deployment

Recorded in [contracts/deployments/testnet.json](../contracts/deployments/testnet.json).

| Contract | Address | Deploy tx |
|---|---|---|
| BeamGifts | `0x649Cdc9A801a8d7918f28FBB3b178568bcFBF0a7` | `0x7bd5f9ba59a0403a0fc3359b5569ba26bb56c3b2cc4a729a3f97f95b16488c1c` |
| BeamClaims | `0x6C336c1c86Cf187564878332d38CA973be377f70` | `0x5d02b8a5cff20ce8f6f9ce522fba792e603c8c3c150f997b88c8f985c32185ff` |

Both return the testnet USDC address from `usdc()`.

## First gasless gift (testnet)

Tx `0x56ef2f7682f3fd89443bcf5030200fcd137a8b82f05db3ef2d8e56200219aa6d`, block 66953358, status success.

| | Before | After |
|---|---|---|
| Viewer `0x9F96…52ED` USDC | 20.00 | 19.00 |
| Viewer MON | 0 | 0 |
| Creator `0xF544…1159` USDC | 0.00 | 1.00 |
| Relayer `0x05B2…F811` MON | 4.6439 | 4.6250 |

- The transaction was sent by the relayer; the viewer held zero MON before and after and only signed off-chain.
- USDC moved viewer → creator directly; BeamGifts never held it.
- `GiftSent` was emitted by BeamGifts with from = viewer, to = creator, amount = 1000000,
  displayName = "JUDGE", message = "first gasless gift on Monad", actionCode = 1.
- USDC reports the authorization nonce as used, so the signature cannot be replayed.
- Gas used: 183,503.

Reproduce with [scripts/testnet-gift.ps1](../scripts/testnet-gift.ps1) (simulates only; add `-Send` to broadcast).
It reads `RELAYER_*`, `VIEWER_*` and `CREATOR_*` from `.env`.

## Envio indexer → WebSocket → overlay (§3.4)

Stack on AWS Lightsail (London, 16.61.50.207): Envio HyperIndex 3.12.1 on HyperSync, Hasura
v2.43.0 streaming subscription (100 ms refetch), Beam server WebSocket. 2026-09-30.

- The indexer backfilled the first gasless gift (`0x56ef2f76…`) and switched to realtime.
- A real $2 gift sent through the relayer API (`0xae44ab177297bac3ed15475151b01f7bb6121875fa4879e9484716aeccac24c4`)
  fired the overlay alert ("$2 · JUDGE · live through Envio + WebSocket"), moved the goal bar
  from $1 to $3 and topped the recent list. No step used polling of an RPC.

End-to-end latency, three real $0.50 gifts, all stages timed on the VPS clock by
`server/scripts/latency-probe.ts` (overlay WebSocket connected to the server on the VPS):

| Tx | Relay request → receipt | Receipt → overlay WebSocket | Total |
|---|---|---|---|
| `0xff1ee253…860d` | 720 ms | 1041 ms | 1761 ms |
| `0x0c163ce9…5b04` | 680 ms | 134 ms | 814 ms |
| `0x537aa257…2d39` | 698 ms | 557 ms | 1255 ms |

Settlement is steady (~0.7 s including simulation). Indexing adds 0.1–1.0 s: HyperSync is polled
about once a second. Envio's realtime-RPC mode could remove most of that, but every public Monad
testnet RPC caps `eth_getLogs` at 100 blocks and throttles bursts (30 parallel requests took
7–27 s; Ankr failed a third), and Envio fell back to HyperSync within ~4 s each minute. It needs a
dedicated RPC endpoint (`ENVIO_REALTIME_RPC`).

Bug found and fixed here: a (re)syncing indexer streams old gifts, which would have replayed old
alerts on stream. The server now only broadcasts gifts from the last 60 s.

### Finding: free HyperSync rate limit stalls realtime alerts

Later probes (same stack) took 53 s, 24 s, then 1.2 s. Sampling Envio's progress against the chain
head every second for 3 minutes (18:40–18:43 UTC) showed a one-minute cycle: fetching stops for
~50 s (up to 182 blocks behind), then catches up at ~:01 past the minute. HyperSync itself was never
more than 4 blocks behind the head over 2 minutes. Envio logs the cause:

    WARN: HyperSync source is rate-limited - not critical, the indexer will retry in 54s.
    For higher limits upgrade your plan at https://envio.dev/app/api-tokens.

The free token is "fair-use" rate limited; Starter ($70/month) allows 100 requests/minute
(envio.dev/pricing/hypersync, 2026-09-30). The alternative is a dedicated RPC for realtime
(`ENVIO_REALTIME_RPC`) so HyperSync is only used for historical sync. The earlier ~1 s results
were measured inside the unthrottled part of the cycle and are not representative until this is fixed.

### Fix: alerts from the chain's own log push (Envio as backup)

Decision (2026-09-30): rather than paying for HyperSync or an RPC plan, the server subscribes to
BeamGifts and BeamClaims events over Monad's public WebSocket (`eth_subscribe` logs: push, free
while idle) and alerts from whichever source delivers a gift first, de-duplicated by the id Envio
assigns (`chainId-txHash-logIndex`). Envio still serves history, goal totals and the recent list,
and is the backup alert source. Five real $0.50 gifts, timed on the VPS clock by
`server/scripts/latency-probe.ts`:

| Tx | Relay → receipt | Relay → overlay WebSocket |
|---|---|---|
| `0x41e30264…c161` | 394 ms | 385 ms |
| `0xea97cd9b…1b1e` | 686 ms | 548 ms |
| `0xd66972d3…45fd` | 369 ms | 264 ms |
| `0xf17dd4a8…0f4a` | 666 ms | 576 ms |
| `0xa6a6ed90…c931` | 680 ms | 423 ms |

The overlay receives each gift before the relayer's own receipt returns. The chain push won every
time; Envio's copies arrived 0.3–36 s later and were dropped as duplicates (logged).

## Gift-a-chatter on stream (testnet)

BeamClaims redeployed with a sender-signed `channel` on every drop:
`0x5f7C6f905f013002b51970D7D0c5b28Ead5d585C` (tx `0x7383459b3a4ded024212663d419f26508c481676cf261823f326e80ff3e65ef1`).
The previous BeamClaims (`0x6C33…7f70`) never held a drop. 50 fork tests pass on mainnet and testnet,
including a relayer swapping the channel (rejected by USDC's signature check).

Run with `server/scripts/chatter-gift.ts`, 2026-09-30, with the overlay open on the creator's channel:

- Drop created by the relayer from the viewer's signature: `0x9d5f774e47b3d163593d9d2b4b49e0525a4ff96175413e9567d232a3ed35e739`.
- The overlay showed "$1 · JUDGE gifted @Tunde 🎁 · welcome to the stream"; the server routed it to
  the channel's overlay 817 ms after the block timestamp. The goal bar correctly did not move
  (the money went to the chatter, not the creator).
- A brand-new account claimed it through the relayer:
  `0xba4568d339dc4f339521dc0ff06d96ad9e6144021def6863cd9c13b161f44dcd`. The claimant ends with
  1 USDC and 0 MON.

Indexer rebuilt from an empty database after the schema change: all five earlier gifts came back
(total $4.50) and the server logged each as "backfill, not alerted", confirming no replay on stream.

## Gift-a-chatter through the public API (testnet)

`server/scripts/claim-flow.ts` against https://beamstreams.xyz, 2026-09-30, calling the API exactly
as the gift and claim pages do (claim key made client-side, secret only in the URL fragment):

| Step | Result |
|---|---|
| `/api/relay/drop` from the sender's signature | 643 ms, `0x10eee61916dd57f43e8f331cbf8f852499886ab4840dc9dab1a7b96a56c3e9f6` |
| `/api/relay/claim` into a brand-new wallet | 933 ms, `0x24c0e010d25018ba0a83cfaeed8bb8338c2a1c0cf9f2e6fbaf78472aea8e1662`; chatter holds $1 USDC, 0 MON |
| Same link claimed again | refused: `DropClosed` |
| `/api/relay/reclaim` of an unclaimed $0.50 | returned to sender: `0x2155d88cc81300d08541a31db4bb2b6895f6885735a07fd6a8e20d7b906322bd` |

Sender balance $8.50 → $7.50 ($1 claimed, $0.50 returned), MON 0 throughout. Found and fixed: a link
opened seconds after sending showed no sender name (indexer lag); the server now answers from the
chain push.

## Beam Bomb through the public API (testnet)

`server/scripts/bomb-flow.ts` against https://beamstreams.xyz, 2026-09-30: a $1 pool across 3 slots,
one link derived from a single seed (163 characters).

| Case | Result |
|---|---|
| Bomb created | `0x1f0ad20a5576cf40488e6bc1a33e0669670ec6b36dfec0f9f905230f70493ece` |
| A and B claim slot 0 at the same instant | A: slot 0 `0xdcc22ca7…b5d6`; B lost the race, retried, slot 1 `0x03be3759…958e` |
| A claims again | refused: `AlreadyClaimed` |
| C | slot 2 `0x37a0d36a…025e` |
| D arrives after all slots are gone | "all claimed", no transaction sent |
| Payouts | A, B, C: 333,333 units each, 0 MON; D: 0 |
| Dust | drop closed with 0 remaining; sender paid 999,999 units (1 unit of dust returned) |

Known limit: "one share per wallet" stops one wallet taking two shares, but a person can make several
passkey wallets. Bomb links should be dropped in chat for a crowd, not relied on for strict fairness.

## Instant splits and signed creator settings (testnet)

`server/scripts/split-flow.ts` against https://beamstreams.xyz, 2026-09-30:

| Case | Result |
|---|---|
| Creator signs settings: Mod 10%, Charity 5% | saved; creator keeps 85% |
| Same settings signed by another wallet | refused: 403 |
| Viewer gifts $1 | one transaction, 918 ms: `0x828e4f1283630a8142a2d04d3b726aff8b29f262e32b6fc1ab2c4ad600ab9893` |
| Payouts | creator +$0.85, mod +$0.10, charity +$0.05, BeamGifts +$0 |

Found and fixed: Monad's log subscription delivers a transaction's logs one at a time, so the chain
push labelled that split "Direct". Logs are now grouped per transaction for 60 ms; the re-run
(`0x09295b35340a31109a46f7b878aa164ab1ced588d2e134d2a85f2b24de0d2eb4`) arrived as a Split.

## Mera passkey gate (§3.2), real phone

2026-09-30, beamstreams.xyz (rpId `beamstreams.xyz`), `@category-labs/mera` 0.2.0.

| Step | Result |
|---|---|
| Create a passkey wallet on the user's phone (claim page) | `0x2091f4594c2b06b224fbca49267f2304938a0086` |
| Receive: claim a $0.50 chatter gift into it, gaslessly | `0xa35bea196e68c12ebf28689df76292ed95a13ea88ce5cf6539146293d4cbcd3d`; wallet holds $0.50, 0 MON |
| Send a gift from it (gift page, scanned from the overlay QR in Beam Studio) | `0x314435fb0a5e32985aabe7f920bd63656be4beae72d56104175079c4e62a1ff6` ("Stella", $0.50); on both open overlays 399 ms after its block; wallet still 0 MON |
| Recover on another device / after forgetting this one | pending |

## Not yet verified

- Split gifts, claims, reclaims and bombs against the live deployment (covered by fork tests only).
- Any mainnet transaction.
- Mera passkey signing on a real device.

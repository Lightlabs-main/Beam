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

## Not yet verified

- Split gifts, claims, reclaims and bombs against the live deployment (covered by fork tests only).
- Any mainnet transaction.
- Mera passkey signing on a real device.

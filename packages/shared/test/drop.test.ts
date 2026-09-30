// Drop helpers checked against the live BeamClaims contract on Monad testnet.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BaseError, ContractFunctionRevertedError, type Hex, createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DropKind,
  type DropParams,
  beamClaimsAbi,
  bombLink,
  deriveClaimKeys,
  firstFreeSlot,
  parseBombFragment,
  claimDigest,
  claimLink,
  deployment,
  dropNonce,
  makeClaimKeys,
  merkleProof,
  merkleRoot,
  parseClaimFragment,
  parseUsdc,
  reclaimDigest,
  signDrop,
  slotLeaf,
  verifyProof,
} from "../src/index.js";

const d = deployment("testnet");
const client = createPublicClient({ chain: d.chain, transport: http() });
const channel = privateKeyToAccount(generatePrivateKey()).address;
const meta = { displayName: "JUDGE", message: "for you", actionCode: 3 };
const now = () => BigInt(Math.floor(Date.now() / 1000));

async function revertReason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (r instanceof ContractFunctionRevertedError) return r.reason ?? r.data?.errorName ?? "";
    }
    throw e;
  }
  throw new Error("expected a revert");
}

function chatterParams(root: Hex): DropParams {
  return { channel, slots: 1, slotRoot: root, expiry: now() + 3600n, recipientLabel: "@Tunde" };
}

describe("drop helpers against live BeamClaims", () => {
  it("computes the same slot leaf", async () => {
    const key = privateKeyToAccount(generatePrivateKey()).address;
    const onChain = await client.readContract({ address: d.beamClaims, abi: beamClaimsAbi, functionName: "slotLeaf", args: [7, key] });
    assert.equal(slotLeaf(7, key), onChain);
  });

  it("computes the same drop id for chatter gifts and bombs", async () => {
    const from = privateKeyToAccount(generatePrivateKey()).address;
    const salt = generatePrivateKey();
    for (const [kind, slots] of [[DropKind.Chatter, 1], [DropKind.Bomb, 5]] as const) {
      const p = { ...chatterParams(makeClaimKeys(slots).root), slots, recipientLabel: kind === DropKind.Bomb ? "" : "@Tunde" };
      const onChain = await client.readContract({
        address: d.beamClaims,
        abi: beamClaimsAbi,
        functionName: "dropNonce",
        args: [from, kind, p, meta, salt],
      });
      assert.equal(dropNonce(d, from, kind, p, meta, salt), onChain);
    }
  });

  it("computes the same claim digest", async () => {
    const dropId = generatePrivateKey();
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const onChain = await client.readContract({
      address: d.beamClaims,
      abi: beamClaimsAbi,
      functionName: "claimDigest",
      args: [dropId, 2, recipient],
    });
    assert.equal(claimDigest(d, dropId, 2, recipient), onChain);
  });

  it("computes the same reclaim digest", async () => {
    const dropId = generatePrivateKey();
    const onChain = await client.readContract({
      address: d.beamClaims,
      abi: beamClaimsAbi,
      functionName: "reclaimDigest",
      args: [dropId, 1_800_000_000n],
    });
    assert.equal(reclaimDigest(d, dropId, 1_800_000_000n), onChain);
  });

  it("signs a drop USDC accepts (fails only on the empty test wallet's balance)", async () => {
    const sender = privateKeyToAccount(generatePrivateKey());
    const params = chatterParams(makeClaimKeys(1).root);
    const { auth } = await signDrop(d, sender, {
      kind: DropKind.Chatter,
      params,
      meta,
      value: parseUsdc("1"),
      validBefore: now() + 600n,
      salt: generatePrivateKey(),
    });
    // receiveWithAuthorization only runs when BeamClaims is the caller, so simulate the real entry point.
    const reason = await revertReason(() =>
      client.simulateContract({ address: d.beamClaims, abi: beamClaimsAbi, functionName: "giftChatter", args: [params, meta, auth] }),
    );
    assert.equal(reason, "ERC20: transfer amount exceeds balance");
  });

  it("is rejected if the drop is moved to another stream", async () => {
    const sender = privateKeyToAccount(generatePrivateKey());
    const params = chatterParams(makeClaimKeys(1).root);
    const { auth } = await signDrop(d, sender, {
      kind: DropKind.Chatter,
      params,
      meta,
      value: parseUsdc("1"),
      validBefore: now() + 600n,
      salt: generatePrivateKey(),
    });
    const moved = { ...params, channel: privateKeyToAccount(generatePrivateKey()).address };
    const reason = await revertReason(() =>
      client.simulateContract({ address: d.beamClaims, abi: beamClaimsAbi, functionName: "giftChatter", args: [moved, meta, auth] }),
    );
    assert.equal(reason, "FiatTokenV2: invalid signature");
  });
});

describe("merkle proofs and claim links", () => {
  it("proves every slot for trees of 1 to 17 leaves", () => {
    for (let n = 1; n <= 17; n++) {
      const { leaves, root } = makeClaimKeys(n);
      assert.equal(merkleRoot(leaves), root);
      for (let i = 0; i < n; i++) assert.ok(verifyProof(merkleProof(leaves, i), root, leaves[i]!), `n=${n} i=${i}`);
      if (n > 1) assert.ok(!verifyProof(merkleProof(leaves, 0), root, leaves[1]!));
    }
  });

  it("round-trips a claim link and keeps the secret in the fragment", () => {
    const { keys, leaves } = makeClaimKeys(5);
    const dropId = generatePrivateKey();
    const link = claimLink("https://beamstreams.xyz", dropId, 3, keys[3]!, merkleProof(leaves, 3));
    const url = new URL(link);
    assert.equal(url.pathname, `/c/${dropId}`);
    assert.ok(!url.search, "nothing secret in the query string");
    const parsed = parseClaimFragment(url.hash);
    assert.deepEqual(parsed, { key: keys[3], slot: 3, proof: merkleProof(leaves, 3) });
    assert.equal(parseClaimFragment("#k=zz&s=1"), null);
  });
});

describe("Beam Bomb links", () => {
  it("derives the same keys and root from the seed on every device", () => {
    const seed = generatePrivateKey();
    const a = deriveClaimKeys(seed, 10);
    const b = deriveClaimKeys(seed, 10);
    assert.deepEqual(a, b);
    assert.equal(new Set(a.keys).size, 10);
    for (let i = 0; i < 10; i++) assert.ok(verifyProof(merkleProof(a.leaves, i), a.root, a.leaves[i]!));
  });

  it("derived leaves match the live contract", async () => {
    const { keys, leaves } = deriveClaimKeys(generatePrivateKey(), 3);
    const onChain = await client.readContract({
      address: d.beamClaims,
      abi: beamClaimsAbi,
      functionName: "slotLeaf",
      args: [2, privateKeyToAccount(keys[2]!).address],
    });
    assert.equal(leaves[2], onChain);
  });

  it("round-trips a short bomb link and finds free slots", () => {
    const seed = generatePrivateKey();
    const link = bombLink("https://beamstreams.xyz", generatePrivateKey(), seed, 25);
    assert.ok(link.length < 200, `bomb link fits in chat (${link.length} chars)`);
    assert.deepEqual(parseBombFragment(new URL(link).hash), { seed, slots: 25 });
    assert.equal(parseBombFragment("#b=abc&n=5"), null);
    assert.equal(firstFreeSlot(0b1011n, 5), 2);
    assert.equal(firstFreeSlot(0b1011n, 5, new Set([2])), 4);
    assert.equal(firstFreeSlot(0b11111n, 5), -1);
  });
});

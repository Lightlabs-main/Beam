// Split helpers against the live BeamGifts contract on Monad testnet.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BaseError, ContractFunctionRevertedError, createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beamGiftsAbi, checkSplit, deployment, parseUsdc, signSplitGift, splitAmounts, splitNonce } from "../src/index.js";

const d = deployment("testnet");
const client = createPublicClient({ chain: d.chain, transport: http() });
const addr = () => privateKeyToAccount(generatePrivateKey()).address;
const meta = { displayName: "JUDGE", message: "for the whole crew", actionCode: 1 };

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

describe("split helpers against live BeamGifts", () => {
  it("computes the same split nonce", async () => {
    const from = addr();
    const split = { recipients: [addr(), addr(), addr()], bps: [8000, 1500, 500] };
    const salt = generatePrivateKey();
    const onChain = await client.readContract({ address: d.beamGifts, abi: beamGiftsAbi, functionName: "splitNonce", args: [from, split.recipients, split.bps, meta, salt] });
    assert.equal(splitNonce(d, from, split, meta, salt), onChain);
  });

  it("computes the same amounts, summing to the gift", async () => {
    for (const [value, bps] of [[1_000_001n, [3333, 3333, 3334]], [7n, [9000, 1000]], [parseUsdc("5"), [5000, 2500, 1500, 1000]]] as const) {
      const onChain = await client.readContract({ address: d.beamGifts, abi: beamGiftsAbi, functionName: "splitAmounts", args: [value, [...bps]] });
      assert.deepEqual(splitAmounts(value, [...bps]), [...onChain]);
      assert.equal(splitAmounts(value, [...bps]).reduce((a, b) => a + b, 0n), value);
    }
  });

  it("signs a split USDC accepts (fails only on the empty test wallet's balance)", async () => {
    const viewer = privateKeyToAccount(generatePrivateKey());
    const split = { recipients: [addr(), addr()], bps: [9000, 1000] };
    const auth = await signSplitGift(d, viewer, { split, meta, value: parseUsdc("1"), validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), salt: generatePrivateKey() });
    const reason = await revertReason(() =>
      client.simulateContract({ address: d.beamGifts, abi: beamGiftsAbi, functionName: "giftWithSplit", args: [split.recipients, split.bps, meta, auth] }),
    );
    assert.equal(reason, "ERC20: transfer amount exceeds balance");
  });

  it("is rejected if a relayer changes the shares", async () => {
    const viewer = privateKeyToAccount(generatePrivateKey());
    const split = { recipients: [addr(), addr()], bps: [9000, 1000] };
    const auth = await signSplitGift(d, viewer, { split, meta, value: parseUsdc("1"), validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), salt: generatePrivateKey() });
    const reason = await revertReason(() =>
      client.simulateContract({ address: d.beamGifts, abi: beamGiftsAbi, functionName: "giftWithSplit", args: [split.recipients, [1000, 9000], meta, auth] }),
    );
    assert.equal(reason, "FiatTokenV2: invalid signature");
  });

  it("validates splits like the contract", () => {
    const [a, b] = [addr(), addr()];
    assert.doesNotThrow(() => checkSplit({ recipients: [a, b], bps: [9000, 1000] }));
    assert.throws(() => checkSplit({ recipients: [a], bps: [10000] }));
    assert.throws(() => checkSplit({ recipients: [a, a], bps: [5000, 5000] }));
    assert.throws(() => checkSplit({ recipients: [a, b], bps: [9000, 999] }));
    assert.throws(() => checkSplit({ recipients: [a, b], bps: [10000, 0] }));
  });
});

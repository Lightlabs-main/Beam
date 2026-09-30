// Runs against live Monad testnet: every expectation is checked by the deployed contracts.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  domainSeparator,
  http,
  keccak256,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  beamGiftsAbi,
  deployment,
  formatUsdc,
  giftNonce,
  parseUsdc,
  signGift,
  usdcDomain,
  usdLabel,
} from "../src/index.js";

const d = deployment("testnet");
const client = createPublicClient({ chain: d.chain, transport: http() });
const usdcDomainAbi = [
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

const meta = { displayName: "JUDGE", message: "gg ✨", actionCode: 1 };
const creator = privateKeyToAccount(generatePrivateKey()).address;

async function revertReason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BaseError) {
      const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) return revert.reason ?? revert.data?.errorName ?? "";
    }
    throw e;
  }
  throw new Error("expected a revert");
}

describe("gift signing against live Monad testnet", () => {
  it("computes the same gift nonce as BeamGifts", async () => {
    const from = privateKeyToAccount(generatePrivateKey()).address;
    const salt = keccak256(toHex("nonce-test"));
    const onChain = await client.readContract({
      address: d.beamGifts,
      abi: beamGiftsAbi,
      functionName: "giftNonce",
      args: [from, creator, meta, salt],
    });
    assert.equal(giftNonce(d, from, creator, meta, salt), onChain);
  });

  it("uses the EIP-712 domain the deployed USDC uses", async () => {
    const onChain = await client.readContract({ address: d.usdc, abi: usdcDomainAbi, functionName: "DOMAIN_SEPARATOR" });
    assert.equal(domainSeparator({ domain: usdcDomain(d) }), onChain);
  });

  it("produces a signature USDC accepts (fails only on the empty test wallet's balance)", async () => {
    const viewer = privateKeyToAccount(generatePrivateKey());
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
    const auth = await signGift(d, viewer, { to: creator, meta, value: parseUsdc("1"), validBefore, salt: keccak256(toHex("ok")) });
    const reason = await revertReason(() =>
      client.simulateContract({ address: d.beamGifts, abi: beamGiftsAbi, functionName: "giftCreator", args: [creator, meta, auth] }),
    );
    assert.equal(reason, "ERC20: transfer amount exceeds balance");
  });

  it("is rejected by USDC if a relayer alters the message", async () => {
    const viewer = privateKeyToAccount(generatePrivateKey());
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
    const auth = await signGift(d, viewer, { to: creator, meta, value: parseUsdc("1"), validBefore, salt: keccak256(toHex("tamper")) });
    const reason = await revertReason(() =>
      client.simulateContract({
        address: d.beamGifts,
        abi: beamGiftsAbi,
        functionName: "giftCreator",
        args: [creator, { ...meta, message: "rugged" }, auth],
      }),
    );
    assert.equal(reason, "FiatTokenV2: invalid signature");
  });
});

describe("USDC amounts", () => {
  it("parses and formats without floating point", () => {
    assert.equal(parseUsdc("1"), 1_000_000n);
    assert.equal(parseUsdc("0.5"), 500_000n);
    assert.equal(parseUsdc("12.345678"), 12_345_678n);
    assert.equal(formatUsdc(1_000_000n), "1");
    assert.equal(formatUsdc(500_000n), "0.5");
    assert.equal(formatUsdc(12_345_678n), "12.345678");
    assert.throws(() => parseUsdc("1.2345678"));
    assert.throws(() => parseUsdc("-1"));
    assert.throws(() => parseUsdc("1e6"));
  });

  it("labels dollars to the cent", () => {
    assert.equal(usdLabel(1_000_000n), "$1");
    assert.equal(usdLabel(500_000n), "$0.50");
    assert.equal(usdLabel(12_345_678n), "$12.35");
    assert.equal(usdLabel(0n), "$0");
  });
});

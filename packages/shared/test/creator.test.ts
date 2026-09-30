import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type CreatorConfig, deployment, signCreatorConfig, splitOf, verifyCreatorConfig } from "../src/index.js";

const d = deployment("testnet");
const creator = privateKeyToAccount(generatePrivateKey());
const mod = privateKeyToAccount(generatePrivateKey()).address;
const base: CreatorConfig = {
  creator: creator.address,
  displayName: "Tunde Live",
  goal: { usdc: "100", title: "New mic", since: 1_790_000_000 },
  shares: [{ address: mod, bps: 1000, label: "Mod" }],
  updatedAt: 1_790_800_000_000,
};

describe("creator settings", () => {
  it("only verify for the creator's own signature", async () => {
    const sig = await signCreatorConfig(d, creator, base);
    assert.equal(await verifyCreatorConfig(d, base, sig), true);
    assert.equal(await verifyCreatorConfig(d, { ...base, shares: [{ address: mod, bps: 5000, label: "Mod" }] }, sig), false);
    const stranger = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(signCreatorConfig(d, stranger, base));
    const forged = await stranger.signTypedData({
      domain: { name: "Beam", version: "1", chainId: d.chain.id },
      types: { BeamCreatorConfig: [{ name: "config", type: "string" }] },
      primaryType: "BeamCreatorConfig",
      message: { config: "x" },
    });
    assert.equal(await verifyCreatorConfig(d, base, forged), false);
  });

  it("builds the on-chain split with the creator first, keeping the remainder", () => {
    assert.deepEqual(splitOf(base), { recipients: [creator.address, mod], bps: [9000, 1000] });
    assert.equal(splitOf({ ...base, shares: [] }), null);
    assert.throws(() => splitOf({ ...base, shares: [{ address: mod, bps: 10000, label: "Mod" }] }));
  });
});

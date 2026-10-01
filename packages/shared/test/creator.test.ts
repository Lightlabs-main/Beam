import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type CreatorConfig, deployment, parseStreamLink, signCreatorConfig, splitOf, verifyCreatorConfig } from "../src/index.js";

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

describe("stream links", () => {
  it("parses what creators paste", () => {
    assert.deepEqual(parseStreamLink("twitch", "https://www.twitch.tv/tunde_live"), { platform: "twitch", channel: "tunde_live" });
    assert.deepEqual(parseStreamLink("twitch", "@tunde_live"), { platform: "twitch", channel: "tunde_live" });
    assert.deepEqual(parseStreamLink("kick", "kick.com/tunde-live"), { platform: "kick", channel: "tunde-live" });
    assert.deepEqual(parseStreamLink("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { platform: "youtube", channel: "dQw4w9WgXcQ" });
    assert.deepEqual(parseStreamLink("youtube", "https://youtu.be/dQw4w9WgXcQ"), { platform: "youtube", channel: "dQw4w9WgXcQ" });
    assert.deepEqual(parseStreamLink("youtube", "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw"), {
      platform: "youtube",
      channel: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
    });
    assert.equal(parseStreamLink("twitch", "not a channel!"), null);
    assert.equal(parseStreamLink("youtube", "https://www.youtube.com/@somehandle"), null);
  });

  it("keeps settings signed before streams existed valid, and signs the stream when set", async () => {
    const legacy = { ...base, updatedAt: base.updatedAt + 1 };
    const sig = await signCreatorConfig(d, creator, legacy);
    assert.equal(await verifyCreatorConfig(d, { ...legacy, stream: null }, sig), true);
    const withStream = { ...legacy, stream: { platform: "twitch" as const, channel: "tunde_live" } };
    const sig2 = await signCreatorConfig(d, creator, withStream);
    assert.equal(await verifyCreatorConfig(d, withStream, sig2), true);
    assert.equal(await verifyCreatorConfig(d, { ...withStream, stream: { platform: "twitch", channel: "someone_else" } }, sig2), false);
  });
});

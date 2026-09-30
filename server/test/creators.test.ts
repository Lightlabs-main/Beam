import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type CreatorConfig, deployment, parseUsdc, signCreatorConfig, signSplitGift } from "@beam/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CreatorStore } from "../src/creators.js";
import { RelayError, Relayer } from "../src/relayer.js";

const d = deployment("testnet");
const dir = await mkdtemp(join(tmpdir(), "beam-creators-"));
after(() => rm(dir, { recursive: true, force: true }));

const creator = privateKeyToAccount(generatePrivateKey());
const mod = privateKeyToAccount(generatePrivateKey()).address;
const config = (updatedAt: number, bps = 1000): CreatorConfig => ({
  creator: creator.address,
  displayName: "Tunde Live",
  goal: { usdc: "100", title: "New mic", since: 1_790_000_000 },
  shares: [{ address: mod, bps, label: "Mod" }],
  updatedAt,
});
const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof RelayError) return e.status;
    throw e;
  }
}

describe("creator settings store", () => {
  const store = new CreatorStore(d, dir);

  it("saves settings signed by the creator and serves them back", async () => {
    const c = config(Date.now() - 1000);
    await store.put(creator.address, { config: c, signature: await signCreatorConfig(d, creator, c) });
    const fresh = new CreatorStore(d, dir); // survives a restart
    assert.deepEqual((await fresh.get(creator.address))?.config.shares, c.shares);
  });

  it("refuses settings not signed by the creator", async () => {
    const c = config(Date.now());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const sig = await stranger.signTypedData({
      domain: { name: "Beam", version: "1", chainId: d.chain.id },
      types: { BeamCreatorConfig: [{ name: "config", type: "string" }] },
      primaryType: "BeamCreatorConfig",
      message: { config: "anything" },
    });
    assert.equal(await status(store.put(creator.address, { config: c, signature: sig })), 403);
  });

  it("refuses a tampered share and an old signed copy", async () => {
    const c = config(Date.now());
    const sig = await signCreatorConfig(d, creator, c);
    assert.equal(await status(store.put(creator.address, { config: { ...c, shares: [{ address: mod, bps: 9000, label: "Mod" }] }, signature: sig })), 403);
    const old = config(1_000);
    assert.equal(await status(store.put(creator.address, { config: old, signature: await signCreatorConfig(d, creator, old) })), 409);
  });

  it("refuses settings saved under another creator's address", async () => {
    const c = config(Date.now());
    assert.equal(await status(store.put(mod, { config: c, signature: await signCreatorConfig(d, creator, c) })), 400);
  });
});

describe("split relay against live Monad testnet", () => {
  const relayer = new Relayer({ d, rpcUrl: d.chain.rpcUrls.default.http[0]!, relayerKey: generatePrivateKey(), relayerFloorWei: 0n, minGiftUnits: parseUsdc("0.1") });
  const meta = { displayName: "JUDGE", message: "for the crew", actionCode: 1 };

  it("simulates a split: a valid signature from an empty wallet fails on balance", async () => {
    const viewer = privateKeyToAccount(generatePrivateKey());
    const split = { recipients: [creator.address, mod], bps: [9000, 1000] };
    const auth = await signSplitGift(d, viewer, { split, meta, value: parseUsdc("1"), validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), salt: generatePrivateKey() });
    try {
      await relayer.relaySplit(json({ split, meta, auth }));
      assert.fail("expected a refusal");
    } catch (e) {
      assert.ok(e instanceof RelayError);
      assert.equal(e.status, 422);
      assert.equal(e.message, "ERC20: transfer amount exceeds balance");
    }
  });

  it("rejects shares that don't add up before touching the chain", async () => {
    const viewer = privateKeyToAccount(generatePrivateKey());
    const split = { recipients: [creator.address, mod], bps: [9000, 1000] };
    const auth = await signSplitGift(d, viewer, { split, meta, value: parseUsdc("1"), validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), salt: generatePrivateKey() });
    assert.equal(await status(relayer.relaySplit(json({ split: { ...split, bps: [9000, 999] }, meta, auth }))), 400);
  });
});

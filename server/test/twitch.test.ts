import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { clean, parseGiftCommand } from "../src/twitch.js";

describe("Beam chat bot", () => {
  it("parses !gift commands", () => {
    assert.deepEqual(parseGiftCommand("!gift"), { to: null, amount: null });
    assert.deepEqual(parseGiftCommand("!gift @Tunde"), { to: "@Tunde", amount: null });
    assert.deepEqual(parseGiftCommand("!gift tunde_live 5"), { to: "@tunde_live", amount: "5" });
    assert.deepEqual(parseGiftCommand("!GIFT @Ada $2.50"), { to: "@Ada", amount: "2.50" });
    assert.equal(parseGiftCommand("!gifts"), null);
    assert.equal(parseGiftCommand("hello !gift"), null);
    assert.equal(parseGiftCommand("!gift @a b c"), null);
  });

  it("keeps viewer text to one safe line", () => {
    // A name or message must never smuggle a second IRC command into the bot's output.
    assert.equal(clean("hi\r\nPRIVMSG #other :spam"), "hi PRIVMSG #other :spam");
    assert.equal(clean("a b\u0007c"), "a b c");
    assert.equal(clean("x".repeat(200), 10), `${"x".repeat(9)}…`);
    assert.equal(clean("Stella"), "Stella");
  });
});

describe("Beam chat bot only joins channels their owners proved", () => {
  it("ignores an impostor who typed someone else's channel", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { deployment, signCreatorConfig } = await import("@beam/shared");
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const { CreatorStore } = await import("../src/creators.js");
    const { BeamBot } = await import("../src/twitch.js");

    const d = deployment("testnet");
    const dir = await mkdtemp(join(tmpdir(), "beam-bot-"));
    try {
      const owner = privateKeyToAccount(generatePrivateKey());
      const impostor = privateKeyToAccount(generatePrivateKey());
      const unproven = privateKeyToAccount(generatePrivateKey());
      // tunde_live logged in with Twitch from the owner's wallet; nobody proved "other_channel".
      await writeFile(join(dir, "twitch-links.json"), JSON.stringify({ tunde_live: owner.address.toLowerCase() }));
      const store = new CreatorStore(d, dir);
      const settings = (account: typeof owner, channel: string, t: number) => ({
        creator: account.address,
        displayName: "x",
        goal: null,
        shares: [],
        stream: { platform: "twitch" as const, channel },
        chatBot: true,
        updatedAt: t,
      });
      for (const [account, channel] of [[owner, "tunde_live"], [impostor, "tunde_live"], [unproven, "other_channel"]] as const) {
        const c = settings(account, channel, Date.now() - 1000);
        await store.put(account.address, { config: c, signature: await signCreatorConfig(d, account, c) });
      }
      const bot = new BeamBot({ clientId: "x", clientSecret: "x", publicUrl: "https://beamstreams.xyz", dataDir: dir }, store);
      await bot.links.load();
      await bot.refreshChannels();
      assert.deepEqual(bot.joined(), [["tunde_live", owner.address.toLowerCase()]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

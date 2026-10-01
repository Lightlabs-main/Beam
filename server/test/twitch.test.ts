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

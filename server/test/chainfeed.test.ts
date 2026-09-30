// Converts real receipts from Monad testnet into gifts and checks them against the indexer's
// view of the same transactions (ids must match exactly for de-duplication to work).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deployment } from "@beam/shared";
import { type Hex, createPublicClient, http } from "viem";
import { giftsFromLogs } from "../src/chainfeed.js";

const d = deployment("testnet");
const client = createPublicClient({ chain: d.chain, transport: http() });
const logsOf = async (hash: Hex) => (await client.getTransactionReceipt({ hash })).logs;

describe("chain log push → gifts (live testnet receipts)", () => {
  it("reads a direct gift exactly as the indexer stores it", async () => {
    const hash = "0xae44ab177297bac3ed15475151b01f7bb6121875fa4879e9484716aeccac24c4";
    const gifts = giftsFromLogs(d, await logsOf(hash));
    assert.equal(gifts.length, 1);
    const g = gifts[0]!;
    assert.equal(g.kind, "Direct");
    assert.equal(g.amount, "2000000");
    assert.equal(g.displayName, "JUDGE");
    assert.equal(g.message, "live through Envio + WebSocket");
    assert.equal(g.to, "0xf5446059ba06fe5381c6cbd21294a43e19b31159");
    assert.equal(g.channel, g.to);
    assert.equal(g.blockNumber, 66977070);
    // Same id and ordering key Envio assigns: chainId-txHash-logIndex, blockNumber * 1e6 + logIndex.
    assert.match(g.id, new RegExp(`^10143-${hash}-\\d+$`));
    assert.equal(g.seq, (66977070n * 1_000_000n + BigInt(g.id.split("-")[2]!)).toString());
  });

  it("reads a chatter gift with its channel and label", async () => {
    const gifts = giftsFromLogs(d, await logsOf("0x9d5f774e47b3d163593d9d2b4b49e0525a4ff96175413e9567d232a3ed35e739"));
    assert.equal(gifts.length, 1);
    const g = gifts[0]!;
    assert.equal(g.kind, "Chatter");
    assert.equal(g.channel, "0xf5446059ba06fe5381c6cbd21294a43e19b31159");
    assert.equal(g.to, null);
    assert.equal(g.recipientLabel, "@Tunde");
    assert.equal(g.message, "welcome to the stream");
    assert.equal(g.amount, "1000000");
    assert.equal(g.dropId, "0x18f3adff7317aa85201c8462b8fe2b541eadcb29d2ebb5caf268e4b99dba114c");
  });

  it("ignores logs from other contracts (USDC transfers in the same receipt)", async () => {
    const logs = await logsOf("0xae44ab177297bac3ed15475151b01f7bb6121875fa4879e9484716aeccac24c4");
    assert.ok(logs.some((l) => l.address.toLowerCase() === d.usdc.toLowerCase()));
    assert.equal(giftsFromLogs(d, logs.filter((l) => l.address.toLowerCase() === d.usdc.toLowerCase())).length, 0);
  });
});

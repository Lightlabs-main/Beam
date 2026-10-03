import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";
import { Indexed } from "../src/feed.js";

const indexed = new Indexed({ httpUrl: "http://indexer.test/graphql", wsUrl: "ws://indexer.test/graphql", adminSecret: "test" });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const gift = (overrides: Record<string, unknown> = {}) => ({
  id: "143-0xgift-1",
  seq: "1000001",
  kind: "Direct",
  from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  channel: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  amount: "1000000",
  displayName: "Alice",
  message: "hello",
  actionCode: 1,
  dropId: null,
  recipientLabel: null,
  slots: null,
  ts: "1000",
  blockNumber: 1,
  txHash: "0xgift",
  ...overrides,
});

describe("wallet portfolio activity", () => {
  it("combines direct, split, claim and reclaim rows with correct signs", async () => {
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            gifts: [
              gift(),
              gift({ id: "143-0xsplit-1", seq: "1000002", kind: "Split", from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", to: "0xcccccccccccccccccccccccccccccccccccccccc", amount: "2000000", txHash: "0xsplit" }),
            ],
            payouts: [{ id: "payout-0", giftId: "143-0xsplit-1", amount: "300000", from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ts: "1002", txHash: "0xsplit" }],
            claims: [{ id: "claim-0", dropId: "0xdrop", amount: "500000", slot: 0, ts: "1003", txHash: "0xclaim" }],
            reclaims: [{ id: "reclaim-0", dropId: "0xdrop", amount: "500000", expired: false, ts: "1004", txHash: "0xreclaim" }],
          },
        }),
      }) as Response;

    const rows = await indexed.accountActivity("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 100);
    assert.deepEqual(rows.map((r) => [r.kind, r.amount]), [
      ["reclaimed", "500000"],
      ["claimed", "500000"],
      ["received", "300000"],
      ["received", "1000000"],
      ["sent", "2000000"],
    ]);
    assert.equal(rows.find((r) => r.giftKind === "Split")?.displayName, "Alice");
  });

  it("fills secondary split payout metadata from its parent gift", async () => {
    let calls = 0;
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => {
          calls++;
          return calls === 1
            ? {
                data: {
                  gifts: [],
                  payouts: [{ id: "payout-1", giftId: "143-0xparent-1", amount: "300000", from: gift().from, ts: "1005", txHash: "0xparent" }],
                  claims: [],
                  reclaims: [],
                },
              }
            : { data: { gifts: [gift({ id: "143-0xparent-1", kind: "Split", displayName: "Crew gift", message: "for the team" })] } };
        },
      }) as Response;

    const rows = await indexed.accountActivity("0xcccccccccccccccccccccccccccccccccccccccc", 100);
    assert.equal(rows[0]?.displayName, "Crew gift");
    assert.equal(rows[0]?.message, "for the team");
    assert.equal(calls, 2);
  });
});

describe("earnings split history", () => {
  it("loads the split gift row for a secondary recipient", async () => {
    const queries: string[] = [];
    globalThis.fetch = async (_input, init) => {
      queries.push(String(init?.body));
      return ({
        ok: true,
        json: async () =>
          queries.length === 1
            ? { data: { direct: { aggregate: { count: 0, sum: { amount: null } } }, shares: { aggregate: { count: 1, sum: { amount: "300000" } } }, payouts: [{ giftId: "143-0xsplit-1", amount: "300000" }] } }
            : { data: { gifts: [gift({ id: "143-0xsplit-1", kind: "Split", to: "0xcccccccccccccccccccccccccccccccccccccccc", amount: "2000000" })] } },
      }) as Response;
    };
    const result = await indexed.earnings("0xcccccccccccccccccccccccccccccccccccccccc", 30);
    assert.equal(result.total, 300000n);
    assert.equal(result.recent.length, 1);
    assert.equal(result.recent[0]!.received, "300000");
    assert.match(queries[1]!, /_in/);
  });
});

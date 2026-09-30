// Runs against live Monad testnet. Keys are generated per test and hold nothing, so no test
// broadcasts a transaction; the chain's own simulation decides every outcome.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DropKind, deployment, makeClaimKeys, parseUsdc, signDrop, signGift, signReclaim } from "@beam/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RelayError, Relayer } from "../src/relayer.js";

const d = deployment("testnet");
const creator = privateKeyToAccount(generatePrivateKey()).address;
const meta = { displayName: "JUDGE", message: "gg", actionCode: 1 };

const relayer = (floor = 0n) =>
  new Relayer({
    d,
    rpcUrl: d.chain.rpcUrls.default.http[0]!,
    relayerKey: generatePrivateKey(),
    relayerFloorWei: floor,
    minGiftUnits: parseUsdc("0.1"),
  });

const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function signedBody(value = parseUsdc("1"), overrides: Record<string, unknown> = {}) {
  const viewer = privateKeyToAccount(generatePrivateKey());
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const auth = await signGift(d, viewer, { to: creator, meta, value, validBefore, salt: generatePrivateKey() });
  return json({ to: creator, meta, auth, ...overrides });
}

async function rejection(p: Promise<unknown>): Promise<RelayError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RelayError) return e;
    throw e;
  }
  throw new Error("expected the relayer to refuse");
}

describe("relayer request validation", () => {
  it("rejects malformed bodies", async () => {
    const e = await rejection(relayer().relayGift({ to: "nope" }));
    assert.equal(e.status, 400);
  });

  it("rejects gifts below the sponsorship minimum", async () => {
    const e = await rejection(relayer().relayGift(await signedBody(parseUsdc("0.05"))));
    assert.equal(e.status, 400);
    assert.match(e.message, /minimum/);
  });

  it("rejects expired authorizations before touching the chain", async () => {
    const body = await signedBody();
    body.auth.validBefore = "1";
    const e = await rejection(relayer().relayGift(body));
    assert.equal(e.status, 400);
    assert.match(e.message, /expired/);
  });

  it("rejects messages over the on-chain limit", async () => {
    const e = await rejection(relayer().relayGift(await signedBody(undefined, { meta: { ...meta, message: "x".repeat(201) } })));
    assert.equal(e.status, 400);
  });
});

describe("relayer against live Monad testnet", () => {
  it("pauses sponsorship when its gas balance is below the floor", async () => {
    const e = await rejection(relayer(1n).relayGift(await signedBody()));
    assert.equal(e.status, 503);
  });

  it("simulates before sending: a valid signature from an empty wallet fails on balance, not signature", async () => {
    const e = await rejection(relayer().relayGift(await signedBody()));
    assert.equal(e.status, 422);
    assert.equal(e.message, "ERC20: transfer amount exceeds balance");
  });

  it("refuses a gift whose message was altered after signing", async () => {
    const body = await signedBody();
    body.meta.message = "rugged";
    const e = await rejection(relayer().relayGift(body));
    assert.equal(e.status, 422);
    assert.equal(e.message, "FiatTokenV2: invalid signature");
  });

  it("refuses a gift redirected to another creator", async () => {
    const body = await signedBody();
    body.to = privateKeyToAccount(generatePrivateKey()).address;
    const e = await rejection(relayer().relayGift(body));
    assert.equal(e.status, 422);
    assert.equal(e.message, "FiatTokenV2: invalid signature");
  });
});

describe("drop and claim relay against live Monad testnet", () => {
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  async function signedDrop(overrides: { label?: string; channel?: `0x${string}` } = {}) {
    const sender = privateKeyToAccount(generatePrivateKey());
    const params = {
      channel: creator,
      slots: 1,
      slotRoot: makeClaimKeys(1).root,
      expiry: now() + 3600n,
      recipientLabel: overrides.label ?? "@Tunde",
    };
    const meta = { displayName: "JUDGE", message: "for you", actionCode: 3 };
    const { auth } = await signDrop(d, sender, {
      kind: DropKind.Chatter,
      params,
      meta,
      value: parseUsdc("1"),
      validBefore: now() + 600n,
      salt: generatePrivateKey(),
    });
    return json({ kind: "chatter", params: { ...params, channel: overrides.channel ?? params.channel }, meta, auth });
  }

  it("simulates a chatter drop: a valid signature from an empty wallet fails on balance", async () => {
    const e = await rejection(relayer().relayDrop(await signedDrop()));
    assert.equal(e.status, 422);
    assert.equal(e.message, "ERC20: transfer amount exceeds balance");
  });

  it("refuses a drop moved to another stream", async () => {
    const e = await rejection(relayer().relayDrop(await signedDrop({ channel: privateKeyToAccount(generatePrivateKey()).address })));
    assert.equal(e.status, 422);
    assert.equal(e.message, "FiatTokenV2: invalid signature");
  });

  it("rejects an over-long recipient label before touching the chain", async () => {
    const e = await rejection(relayer().relayDrop(await signedDrop({ label: "@this-label-is-way-longer-than-32-bytes" })));
    assert.equal(e.status, 400);
  });

  it("refuses to claim a drop that does not exist", async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const e = await rejection(
      relayer().relayClaim({ dropId: generatePrivateKey(), slot: 0, recipient, proof: [], claimSig: `0x${"11".repeat(65)}` }),
    );
    assert.equal(e.status, 422);
    assert.equal(e.message, "UnknownDrop");
  });

  it("refuses to pay the real @Tunde drop twice", async () => {
    const dropId = "0x18f3adff7317aa85201c8462b8fe2b541eadcb29d2ebb5caf268e4b99dba114c";
    const state = await relayer().drop(dropId);
    assert.equal(state.exists, true);
    assert.equal(state.closed, true);
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const e = await rejection(relayer().relayClaim({ dropId, slot: 0, recipient, proof: [], claimSig: `0x${"11".repeat(65)}` }));
    assert.equal(e.status, 422);
    assert.equal(e.message, "DropClosed");
  });
});

describe("reclaim relay against live Monad testnet", () => {
  it("only the drop's sender can take it back", async () => {
    // The real @Tunde drop is closed; a stranger's signature is refused before anything else.
    const dropId = "0x18f3adff7317aa85201c8462b8fe2b541eadcb29d2ebb5caf268e4b99dba114c";
    const stranger = privateKeyToAccount(generatePrivateKey());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const senderSig = await signReclaim(d, stranger, dropId, deadline);
    const e = await rejection(relayer().relayReclaim(json({ dropId, deadline, senderSig })));
    assert.equal(e.status, 422);
    assert.equal(e.message, "NotSender");
  });
});

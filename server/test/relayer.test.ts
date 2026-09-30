// Runs against live Monad testnet. Keys are generated per test and hold nothing, so no test
// broadcasts a transaction; the chain's own simulation decides every outcome.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deployment, parseUsdc, signGift } from "@beam/shared";
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

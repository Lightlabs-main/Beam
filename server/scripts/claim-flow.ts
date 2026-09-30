// Gift-a-chatter through Beam's public API, calling it exactly as the gift and claim pages do:
//   1. the sender's browser makes a claim key, signs a drop, POSTs /api/relay/drop
//   2. the chatter's browser reads /api/drops/:id, signs a claim for a brand-new wallet, POSTs /api/relay/claim
//   3. a second drop is taken back by the sender through /api/relay/reclaim
// Sender = VIEWER_PRIVATE_KEY (testnet). The chatter is a fresh key with no MON and no USDC.
//
//   BEAM_URL=https://beamstreams.xyz pnpm --filter @beam/server exec tsx scripts/claim-flow.ts
import { readFileSync } from "node:fs";
import {
  DropKind,
  claimLink,
  deployment,
  makeClaimKeys,
  parseClaimFragment,
  parseUsdc,
  signClaim,
  signDrop,
  signReclaim,
  usdLabel,
} from "@beam/shared";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = process.env.BEAM_URL ?? "https://beamstreams.xyz";
const cfg = (await (await fetch(`${base}/api/config`)).json()) as { network: "testnet" | "mainnet" };
const d = deployment(cfg.network);
const sender = privateKeyToAccount(env.VIEWER_PRIVATE_KEY as Hex);
const channel = (process.env.CHANNEL ?? env.CREATOR_ADDRESS) as Address;
const now = () => BigInt(Math.floor(Date.now() / 1000));

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path} ${res.status}: ${json.error}`);
  return json;
}
const balances = async (a: string) => (await (await fetch(`${base}/api/accounts/${a}`)).json()) as { usdc: string; mon: string };

async function makeDrop(label: string, message: string, amount: string) {
  const { keys, root } = makeClaimKeys(1);
  const params = { channel, slots: 1, slotRoot: root, expiry: now() + 7n * 86400n, recipientLabel: label };
  const meta = { displayName: "JUDGE", message, actionCode: 3 };
  const { dropId, auth } = await signDrop(d, sender, {
    kind: DropKind.Chatter,
    params,
    meta,
    value: parseUsdc(amount),
    validBefore: now() + 600n,
    salt: generatePrivateKey(),
  });
  const t0 = Date.now();
  const r = await post<{ hash: string; dropId: string }>("/api/relay/drop", { kind: "chatter", params, meta, auth });
  if (r.dropId.toLowerCase() !== dropId.toLowerCase()) throw new Error(`dropId mismatch ${r.dropId} vs ${dropId}`);
  return { dropId, link: claimLink(base, dropId, 0, keys[0]!, []), hash: r.hash, ms: Date.now() - t0 };
}

// CREATE_ONLY=1: make one unclaimed chatter gift and print its full claim link (for page checks).
if (process.env.CREATE_ONLY === "1") {
  const x = await makeDrop(process.env.LABEL ?? "@Ada", process.env.MESSAGE ?? "welcome to the stream", process.env.AMOUNT ?? "0.5");
  const state = await (await fetch(`${base}/api/drops/${x.dropId}?slot=0`)).json();
  console.log(JSON.stringify({ hash: x.hash, link: x.link, from: (state as { from: unknown }).from }));
  process.exit(0);
}

// 1 + 2: gift a chatter, then claim into a brand-new wallet.
const before = await balances(sender.address);
const a = await makeDrop("@Ada", "welcome to the stream", "1");
console.log(`drop created in ${a.ms}ms: ${a.hash}`);
console.log(`claim link: ${a.link.replace(/#.*/, "#<secret>")}`);

const url = new URL(a.link);
const secret = parseClaimFragment(url.hash)!;
const dropId = url.pathname.split("/")[2] as Hex;
const info = (await (await fetch(`${base}/api/drops/${dropId}?slot=${secret.slot}`)).json()) as { perSlot: string; slotClaimed: boolean; from: unknown };
console.log(`link shows: ${usdLabel(BigInt(info.perSlot))}, claimed=${info.slotClaimed}, from=${JSON.stringify(info.from)}`);

const chatter = privateKeyToAccount(generatePrivateKey()).address;
const claimSig = await signClaim(d, secret.key, dropId, secret.slot, chatter);
const t1 = Date.now();
const c = await post<{ hash: string; amount: string }>("/api/relay/claim", { dropId, slot: secret.slot, recipient: chatter, proof: secret.proof, claimSig });
console.log(`claimed in ${Date.now() - t1}ms: ${c.hash}`);
const cb = await balances(chatter);
console.log(`chatter ${chatter}: ${usdLabel(BigInt(cb.usdc))} USDC, ${cb.mon} wei MON`);

// The same link can't be used twice.
try {
  const again = privateKeyToAccount(generatePrivateKey()).address;
  await post("/api/relay/claim", { dropId, slot: 0, recipient: again, proof: [], claimSig: await signClaim(d, secret.key, dropId, 0, again) });
  console.log("ERROR: second claim was accepted");
  process.exit(1);
} catch (e) {
  console.log(`second claim refused: ${(e as Error).message}`);
}

// 3: take back an unclaimed gift.
const b = await makeDrop("@Nobody", "unclaimed test", "0.5");
const deadline = now() + 600n;
const r = await post<{ hash: string; amount: string }>("/api/relay/reclaim", {
  dropId: b.dropId,
  deadline,
  senderSig: await signReclaim(d, sender, b.dropId, deadline),
});
console.log(`took back ${usdLabel(BigInt(r.amount))}: ${r.hash}`);

const after = await balances(sender.address);
console.log(`sender USDC ${usdLabel(BigInt(before.usdc))} -> ${usdLabel(BigInt(after.usdc))} (MON ${after.mon} wei)`);

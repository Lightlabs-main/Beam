// Beam Bomb through Beam's public API, the way the gift and claim pages do it:
//   a $1 pool across 3 slots (333,333 units each; 1 unit of dust returns to the sender),
//   two chatters racing for the same slot, one wallet trying twice, and a latecomer.
// Sender = VIEWER_PRIVATE_KEY (testnet). Every chatter is a fresh key with no MON.
//
//   BEAM_URL=https://beamstreams.xyz pnpm --filter @beam/server exec tsx scripts/bomb-flow.ts
import { readFileSync } from "node:fs";
import {
  DropKind,
  bombLink,
  deployment,
  deriveClaimKeys,
  firstFreeSlot,
  merkleProof,
  parseBombFragment,
  parseUsdc,
  signClaim,
  signDrop,
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

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: Record<string, string> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  return { ok: res.ok, status: res.status, body: (await res.json()) as Record<string, string> };
}
const usdc = async (a: string) => BigInt(((await (await fetch(`${base}/api/accounts/${a}`)).json()) as { usdc: string }).usdc);
const dropState = async (id: Hex) => (await (await fetch(`${base}/api/drops/${id}`)).json()) as { claimedSlots: string; slots: number; claimed: number; closed: boolean; remaining: string };

const senderBefore = await usdc(sender.address);

// Sender: one seed, three slots.
const seed = generatePrivateKey();
const slots = 3;
const { root } = deriveClaimKeys(seed, slots);
const params = { channel, slots, slotRoot: root, expiry: now() + 86400n, recipientLabel: "" };
const meta = { displayName: "JUDGE", message: "BOOM", actionCode: 9 };
const { dropId, auth } = await signDrop(d, sender, { kind: DropKind.Bomb, params, meta, value: parseUsdc("1"), validBefore: now() + 600n, salt: generatePrivateKey() });
const created = await post("/api/relay/drop", { kind: "bomb", params, meta, auth });
if (!created.ok) throw new Error(`drop failed: ${created.body.error}`);
const link = bombLink(base, dropId, seed, slots);
console.log(`bomb ${dropId} created: ${created.body.hash} (link ${link.length} chars)`);

// Each chatter's browser: parse the link, derive keys, pick the first free slot, claim.
const bomb = parseBombFragment(new URL(link).hash)!;
const keys = deriveClaimKeys(bomb.seed, bomb.slots);
async function claimAs(recipient: Address, forceSlot?: number, lost = new Set<number>()): Promise<string> {
  const state = await dropState(dropId);
  const slot = forceSlot ?? firstFreeSlot(BigInt(state.claimedSlots), state.slots, lost);
  if (slot < 0) return "all claimed (no free slot)";
  const r = await post("/api/relay/claim", {
    dropId,
    slot,
    recipient,
    proof: merkleProof(keys.leaves, slot),
    claimSig: await signClaim(d, keys.keys[slot]!, dropId, slot, recipient),
  });
  if (r.ok) return `slot ${slot} ✓ ${r.body.hash}`;
  if (/SlotTaken/.test(r.body.error ?? "")) {
    lost.add(slot);
    return `lost the race for slot ${slot}, retrying → ${await claimAs(recipient, undefined, lost)}`;
  }
  return `refused: ${r.body.error}`;
}

const chatters = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()).address);
// Two chatters open the link at the same instant and both go for slot 0.
const [a, b] = await Promise.all([claimAs(chatters[0]!, 0), claimAs(chatters[1]!, 0)]);
console.log(`chatter A: ${a}`);
console.log(`chatter B: ${b}`);
console.log(`chatter A again: ${await claimAs(chatters[0]!)}`);
console.log(`chatter C: ${await claimAs(chatters[2]!)}`);
console.log(`chatter D (late): ${await claimAs(chatters[3]!)}`);

for (const [i, c] of chatters.entries()) console.log(`  ${"ABCD"[i]} ${c}: ${await usdc(c)} units`);
const s = await dropState(dropId);
console.log(`drop: claimed ${s.claimed}/${s.slots}, closed=${s.closed}, remaining=${s.remaining}`);
const senderAfter = await usdc(sender.address);
console.log(`sender paid ${senderBefore - senderAfter} units (pool 1,000,000 minus dust returned)`);

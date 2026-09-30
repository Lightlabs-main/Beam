import {
  type Address,
  type Hex,
  type LocalAccount,
  encodeAbiParameters,
  hashTypedData,
  hexToSignature,
  keccak256,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "./deployments.js";
import {
  type Authorization,
  type GiftMeta,
  checkMeta,
  receiveWithAuthorizationTypes,
  usdcDomain,
} from "./gift.js";

/** BeamClaims.Kind */
export const DropKind = { Chatter: 0, Bomb: 1 } as const;
export type DropKind = (typeof DropKind)[keyof typeof DropKind];

/** BeamClaims.DropParams */
export type DropParams = {
  channel: Address;
  slots: number;
  slotRoot: Hex;
  expiry: bigint;
  recipientLabel: string;
};

// Mirrors BeamClaims constants.
export const MAX_SLOTS = 100;
export const MIN_TTL_SECONDS = 10n * 60n;
export const MAX_TTL_SECONDS = 30n * 24n * 60n * 60n;
export const MAX_LABEL_BYTES = 32;

const DROP_TAG = keccak256(toHex("Beam.Drop.v1"));

/** BeamClaims.slotLeaf: keccak256(bytes.concat(keccak256(abi.encode(slot, claimKey)))). */
export function slotLeaf(slot: number, claimKey: Address): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "address" }], [slot, claimKey])));
}

const hashPair = (a: Hex, b: Hex): Hex =>
  BigInt(a) < BigInt(b)
    ? keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [a, b]))
    : keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [b, a]));

/** Sorted-pair Merkle tree, as MerkleLib.verify expects; an odd node is promoted unchanged. */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new Error("no leaves");
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0]!;
}

export function merkleProof(leaves: Hex[], index: number): Hex[] {
  const proof: Hex[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) proof.push(level[sib]!);
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(j + 1 < level.length ? hashPair(level[j]!, level[j + 1]!) : level[j]!);
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(proof: Hex[], root: Hex, leaf: Hex): boolean {
  return proof.reduce((h, p) => hashPair(h, p), leaf) === root;
}

/** One-time claim keys generated in the sender's browser; each link carries one secret. */
export function makeClaimKeys(slots: number): { keys: Hex[]; leaves: Hex[]; root: Hex } {
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw new Error(`slots must be 1..${MAX_SLOTS}`);
  const keys = Array.from({ length: slots }, () => generatePrivateKey());
  const leaves = keys.map((k, i) => slotLeaf(i, privateKeyToAccount(k).address));
  return { keys, leaves, root: merkleRoot(leaves) };
}

/** BeamClaims.dropNonce: the sender's EIP-3009 nonce and the drop's id. */
export function dropNonce(d: Deployment, from: Address, kind: DropKind, p: DropParams, meta: GiftMeta, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint8" },
        { type: "address" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "uint16" },
        { type: "bytes32" },
      ],
      [
        DROP_TAG,
        BigInt(d.chain.id),
        d.beamClaims,
        from,
        kind,
        p.channel,
        p.slots,
        p.slotRoot,
        p.expiry,
        p.recipientLabel,
        meta.displayName,
        meta.message,
        meta.actionCode,
        salt,
      ],
    ),
  );
}

export function checkDropParams(p: DropParams, kind: DropKind, nowSeconds: bigint): void {
  if (new TextEncoder().encode(p.recipientLabel).length > MAX_LABEL_BYTES) throw new Error("recipient label too long");
  if (kind === DropKind.Chatter && p.slots !== 1) throw new Error("a chatter gift has exactly one slot");
  if (kind === DropKind.Bomb && (p.slots < 2 || p.slots > MAX_SLOTS)) throw new Error(`a Beam Bomb has 2..${MAX_SLOTS} slots`);
  if (p.expiry < nowSeconds + MIN_TTL_SECONDS || p.expiry > nowSeconds + MAX_TTL_SECONDS) throw new Error("expiry out of range");
}

export type SignDropInput = {
  kind: DropKind;
  params: DropParams;
  meta: GiftMeta;
  value: bigint;
  validBefore: bigint;
  salt: Hex;
};

/** The sender signs a drop: a ReceiveWithAuthorization that only BeamClaims can execute. */
export async function signDrop(d: Deployment, account: LocalAccount, i: SignDropInput): Promise<{ dropId: Hex; auth: Authorization }> {
  checkMeta(i.meta);
  if (i.value / BigInt(i.params.slots) === 0n) throw new Error("amount too small for that many slots");
  const dropId = dropNonce(d, account.address, i.kind, i.params, i.meta, i.salt);
  const signature = await account.signTypedData({
    domain: usdcDomain(d),
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: { from: account.address, to: d.beamClaims, value: i.value, validAfter: 0n, validBefore: i.validBefore, nonce: dropId },
  });
  const { r, s, v } = hexToSignature(signature);
  return {
    dropId,
    auth: { from: account.address, value: i.value, validAfter: 0n, validBefore: i.validBefore, salt: i.salt, v: Number(v), r, s },
  };
}

/** BeamClaims.claimDigest: EIP-712 `Claim(dropId, slot, recipient)` in the BeamClaims domain. */
export function claimDigest(d: Deployment, dropId: Hex, slot: number, recipient: Address): Hex {
  return hashTypedData({
    domain: { name: "BeamClaims", version: "1", chainId: d.chain.id, verifyingContract: d.beamClaims },
    types: { Claim: [{ name: "dropId", type: "bytes32" }, { name: "slot", type: "uint32" }, { name: "recipient", type: "address" }] },
    primaryType: "Claim",
    message: { dropId, slot, recipient },
  });
}

/** The claim key authorizes paying one slot to `recipient`; a copied link can't be redirected in flight. */
export async function signClaim(d: Deployment, claimKey: Hex, dropId: Hex, slot: number, recipient: Address): Promise<Hex> {
  return privateKeyToAccount(claimKey).sign({ hash: claimDigest(d, dropId, slot, recipient) });
}

/** BeamClaims.reclaimDigest: EIP-712 `Reclaim(dropId, deadline)` in the BeamClaims domain. */
export function reclaimDigest(d: Deployment, dropId: Hex, deadline: bigint): Hex {
  return hashTypedData({
    domain: { name: "BeamClaims", version: "1", chainId: d.chain.id, verifyingContract: d.beamClaims },
    types: { Reclaim: [{ name: "dropId", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Reclaim",
    message: { dropId, deadline },
  });
}

/** The sender takes back whatever is unclaimed, gaslessly (the relayer submits reclaimBySig). */
export async function signReclaim(d: Deployment, account: LocalAccount, dropId: Hex, deadline: bigint): Promise<Hex> {
  if (!account.sign) throw new Error("this account cannot sign raw digests");
  return account.sign({ hash: reclaimDigest(d, dropId, deadline) });
}

// ---------------------------------------------------------------- links

/**
 * Claim link: https://<host>/c/<dropId>#k=<claim key>&s=<slot>[&p=<proof>]. Everything after
 * `#` stays in the browser; it is never sent to Beam's server.
 */
export function claimLink(origin: string, dropId: Hex, slot: number, key: Hex, proof: Hex[]): string {
  const frag = new URLSearchParams({ k: key.slice(2), s: String(slot) });
  if (proof.length) frag.set("p", proof.map((h) => h.slice(2)).join("."));
  return `${origin}/c/${dropId}#${frag}`;
}

export function parseClaimFragment(hash: string): { key: Hex; slot: number; proof: Hex[] } | null {
  const f = new URLSearchParams(hash.replace(/^#/, ""));
  const k = f.get("k");
  const s = f.get("s");
  if (!k || !/^[0-9a-f]{64}$/i.test(k) || !s || !/^\d{1,3}$/.test(s)) return null;
  const p = f.get("p");
  const proof = p ? p.split(".").map((h) => `0x${h}` as Hex) : [];
  if (proof.some((h) => !/^0x[0-9a-f]{64}$/i.test(h))) return null;
  return { key: `0x${k}` as Hex, slot: Number(s), proof };
}

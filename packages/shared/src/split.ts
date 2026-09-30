import { type Address, type Hex, type LocalAccount, encodeAbiParameters, hexToSignature, keccak256, toHex } from "viem";
import type { Deployment } from "./deployments.js";
import { type Authorization, type GiftMeta, checkMeta, receiveWithAuthorizationTypes, usdcDomain } from "./gift.js";

// Mirrors BeamGifts.
export const BPS = 10_000;
export const MAX_SPLIT_RECIPIENTS = 10;
const SPLIT_TAG = keccak256(toHex("Beam.SplitGift.v1"));

/** One share of a creator's split. recipients[0] is always the creator and takes the remainder. */
export type Split = { recipients: Address[]; bps: number[] };

export function checkSplit(s: Split): void {
  const n = s.recipients.length;
  if (n < 2 || n > MAX_SPLIT_RECIPIENTS || s.bps.length !== n) throw new Error(`a split has 2..${MAX_SPLIT_RECIPIENTS} recipients`);
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = s.recipients[i]!.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(r) || r === "0x0000000000000000000000000000000000000000") throw new Error("invalid recipient");
    if (seen.has(r)) throw new Error("duplicate recipient");
    seen.add(r);
    const b = s.bps[i]!;
    if (!Number.isInteger(b) || b <= 0 || b > BPS) throw new Error("each share must be between 0.01% and 100%");
    total += b;
  }
  if (total !== BPS) throw new Error("shares must add up to exactly 100%");
}

/** BeamGifts.splitAmounts: every recipient but the first gets floor(value·bps/10000); the first gets the rest. */
export function splitAmounts(value: bigint, bps: number[]): bigint[] {
  const amounts = bps.map(() => 0n);
  let paid = 0n;
  for (let i = 1; i < bps.length; i++) {
    amounts[i] = (value * BigInt(bps[i]!)) / BigInt(BPS);
    paid += amounts[i]!;
  }
  if (bps.length) amounts[0] = value - paid;
  return amounts;
}

/** BeamGifts.splitNonce: binds every recipient, share and the message into the viewer's signature. */
export function splitNonce(d: Deployment, from: Address, s: Split, meta: GiftMeta, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address[]" },
        { type: "uint16[]" },
        { type: "string" },
        { type: "string" },
        { type: "uint16" },
        { type: "bytes32" },
      ],
      [SPLIT_TAG, BigInt(d.chain.id), d.beamGifts, from, s.recipients, s.bps, meta.displayName, meta.message, meta.actionCode, salt],
    ),
  );
}

/** The viewer signs a split gift: a ReceiveWithAuthorization only BeamGifts can execute. */
export async function signSplitGift(
  d: Deployment,
  account: LocalAccount,
  i: { split: Split; meta: GiftMeta; value: bigint; validBefore: bigint; salt: Hex },
): Promise<Authorization> {
  checkMeta(i.meta);
  checkSplit(i.split);
  if (i.value <= 0n) throw new Error("value must be positive");
  const nonce = splitNonce(d, account.address, i.split, i.meta, i.salt);
  const signature = await account.signTypedData({
    domain: usdcDomain(d),
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: { from: account.address, to: d.beamGifts, value: i.value, validAfter: 0n, validBefore: i.validBefore, nonce },
  });
  const { r, s, v } = hexToSignature(signature);
  return { from: account.address, value: i.value, validAfter: 0n, validBefore: i.validBefore, salt: i.salt, v: Number(v), r, s };
}

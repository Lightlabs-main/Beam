import {
  type Address,
  type Hex,
  type LocalAccount,
  encodeAbiParameters,
  hexToSignature,
  keccak256,
  toHex,
} from "viem";
import type { Deployment } from "./deployments.js";

/** What the overlay renders; the viewer's signature commits to all of it. */
export type GiftMeta = { displayName: string; message: string; actionCode: number };

/** BeamTypes.Authorization: an EIP-3009 authorization minus the nonce, which the contract derives. */
export type Authorization = {
  from: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: Hex;
  v: number;
  r: Hex;
  s: Hex;
};

// Mirrors BeamLimits in contracts/src/lib/BeamTypes.sol.
export const MAX_NAME_BYTES = 32;
export const MAX_MESSAGE_BYTES = 200;
export const USDC_DECIMALS = 6;

const GIFT_TAG = keccak256(toHex("Beam.Gift.v1"));

export function checkMeta(meta: GiftMeta): void {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(meta.displayName) > MAX_NAME_BYTES) throw new Error(`displayName over ${MAX_NAME_BYTES} bytes`);
  if (bytes(meta.message) > MAX_MESSAGE_BYTES) throw new Error(`message over ${MAX_MESSAGE_BYTES} bytes`);
  if (!Number.isInteger(meta.actionCode) || meta.actionCode < 0 || meta.actionCode > 0xffff) {
    throw new Error("actionCode must be a uint16");
  }
}

/** BeamGifts.giftNonce, computed locally so signing needs no RPC round trip. */
export function giftNonce(d: Deployment, from: Address, to: Address, meta: GiftMeta, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "string" },
        { type: "string" },
        { type: "uint16" },
        { type: "bytes32" },
      ],
      [GIFT_TAG, BigInt(d.chain.id), d.beamGifts, from, to, meta.displayName, meta.message, meta.actionCode, salt],
    ),
  );
}

/** Circle FiatToken v2 EIP-712 domain, as deployed on Monad (name "USDC", version "2"). */
export const usdcDomain = (d: Deployment) =>
  ({ name: "USDC", version: "2", chainId: d.chain.id, verifyingContract: d.usdc }) as const;

const authorizationFields = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export const transferWithAuthorizationTypes = { TransferWithAuthorization: authorizationFields } as const;
export const receiveWithAuthorizationTypes = { ReceiveWithAuthorization: authorizationFields } as const;

export type SignGiftInput = {
  to: Address;
  meta: GiftMeta;
  /** USDC base units (6 decimals). */
  value: bigint;
  /** Unix seconds after which the authorization is void. */
  validBefore: bigint;
  salt: Hex;
};

/**
 * The viewer signs a direct gift. Off-chain only: no transaction, no MON. Works with any
 * viem LocalAccount, including the EOA a Mera passkey derives.
 */
export async function signGift(d: Deployment, account: LocalAccount, input: SignGiftInput): Promise<Authorization> {
  checkMeta(input.meta);
  if (input.value <= 0n) throw new Error("value must be positive");
  const nonce = giftNonce(d, account.address, input.to, input.meta, input.salt);
  const signature = await account.signTypedData({
    domain: usdcDomain(d),
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: input.to,
      value: input.value,
      validAfter: 0n,
      validBefore: input.validBefore,
      nonce,
    },
  });
  const { r, s, v } = hexToSignature(signature);
  return {
    from: account.address,
    value: input.value,
    validAfter: 0n,
    validBefore: input.validBefore,
    salt: input.salt,
    v: Number(v),
    r,
    s,
  };
}

/** Parses a decimal USDC string ("1", "0.5") into base units without floating point. */
export function parseUsdc(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m?.[1]) throw new Error(`invalid USDC amount: ${amount}`);
  return BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
}

export function formatUsdc(units: bigint): string {
  const whole = units / 10n ** BigInt(USDC_DECIMALS);
  const frac = (units % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

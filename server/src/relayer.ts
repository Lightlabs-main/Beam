import { type Authorization, type Deployment, type GiftMeta, beamGiftsAbi, checkMeta, txUrl } from "@beam/shared";
import {
  type Address,
  type Hex,
  type PublicClient,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const address = z.string().refine(isAddress, "invalid address").transform((a) => a as Address);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte hex").transform((h) => h as Hex);
const uint = z.string().regex(/^\d{1,78}$/, "expected a decimal integer string").transform(BigInt);

export const giftRequest = z.object({
  to: address,
  meta: z.object({
    displayName: z.string(),
    message: z.string(),
    actionCode: z.number().int().min(0).max(0xffff),
  }),
  auth: z.object({
    from: address,
    value: uint,
    validAfter: uint,
    validBefore: uint,
    salt: bytes32,
    v: z.union([z.literal(27), z.literal(28)]),
    r: bytes32,
    s: bytes32,
  }),
});
export type GiftRequest = z.infer<typeof giftRequest>;

/** A request the relayer refuses, with the HTTP status the API should answer with. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RelayResult = { hash: Hex; blockNumber: bigint; status: "success" | "reverted"; explorerUrl: string };

export type RelayerOptions = {
  d: Deployment;
  rpcUrl: string;
  relayerKey: Hex;
  relayerFloorWei: bigint;
  minGiftUnits: bigint;
};

/**
 * Submits viewers' signed gifts and pays their gas. Every request is simulated first, so the
 * relayer only spends gas on transactions the chain will accept, and it stops sponsoring when
 * its own MON balance falls below the configured floor.
 */
export class Relayer {
  readonly publicClient: PublicClient;
  private readonly account;
  private readonly wallet;

  constructor(private readonly o: RelayerOptions) {
    const transport = http(o.rpcUrl);
    this.publicClient = createPublicClient({ chain: o.d.chain, transport });
    this.account = privateKeyToAccount(o.relayerKey, { nonceManager });
    this.wallet = createWalletClient({ account: this.account, chain: o.d.chain, transport });
  }

  get address(): Address {
    return this.account.address;
  }

  async balance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  /** Validates, simulates and submits a direct gift; resolves once the chain has included it. */
  async relayGift(body: unknown): Promise<RelayResult> {
    const req = this.parseGift(body);
    const args = [req.to, req.meta, req.auth] as const;

    if ((await this.balance()) < this.o.relayerFloorWei) {
      throw new RelayError(503, "gift relay is paused: relayer gas balance is below its floor");
    }

    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({
        account: this.account,
        address: this.o.d.beamGifts,
        abi: beamGiftsAbi,
        functionName: "giftCreator",
        args,
      }));
    } catch (e) {
      throw new RelayError(422, revertReason(e));
    }

    const hash = await this.wallet.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    return { hash, blockNumber: receipt.blockNumber, status: receipt.status, explorerUrl: txUrl(this.o.d, hash) };
  }

  parseGift(body: unknown): { to: Address; meta: GiftMeta; auth: Authorization } {
    const parsed = giftRequest.safeParse(body);
    if (!parsed.success) throw new RelayError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { to, meta, auth } = parsed.data;
    try {
      checkMeta(meta);
    } catch (e) {
      throw new RelayError(400, (e as Error).message);
    }
    if (auth.value < this.o.minGiftUnits) throw new RelayError(400, `gift is below the ${this.o.minGiftUnits} unit minimum`);
    if (auth.validBefore <= BigInt(Math.floor(Date.now() / 1000))) throw new RelayError(400, "authorization has expired");
    return { to, meta, auth };
  }
}

export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.reason ?? revert.data?.errorName ?? revert.shortMessage;
    }
    return e.shortMessage;
  }
  return String(e);
}

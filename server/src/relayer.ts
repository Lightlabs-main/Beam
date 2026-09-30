import {
  type Authorization,
  type Deployment,
  DropKind,
  type GiftMeta,
  beamClaimsAbi,
  beamGiftsAbi,
  checkDropParams,
  checkMeta,
  txUrl,
} from "@beam/shared";
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
  zeroAddress,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const erc20BalanceAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

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

const bytes32Array = z.array(bytes32).max(8);

export const dropRequest = z.object({
  kind: z.enum(["chatter", "bomb"]),
  params: z.object({
    channel: address,
    slots: z.number().int().min(1).max(100),
    slotRoot: bytes32,
    expiry: uint,
    recipientLabel: z.string(),
  }),
  meta: giftRequest.shape.meta,
  auth: giftRequest.shape.auth,
});

export const claimRequest = z.object({
  dropId: bytes32,
  slot: z.number().int().min(0).max(99),
  recipient: address,
  proof: bytes32Array,
  claimSig: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte signature").transform((h) => h as Hex),
});

export const reclaimRequest = z.object({
  dropId: bytes32,
  deadline: uint,
  senderSig: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte signature").transform((h) => h as Hex),
});

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

/** A request the relayer refuses, with the HTTP status the API should answer with. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RelayResult = { hash: Hex; blockNumber: bigint; status: "success"; explorerUrl: string };

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

  /** A viewer's balances: USDC to gift with, and MON, which Beam never asks them to hold. */
  async balances(address: Address): Promise<{ address: Address; usdc: bigint; mon: bigint }> {
    const [usdc, mon] = await Promise.all([
      this.publicClient.readContract({ address: this.o.d.usdc, abi: erc20BalanceAbi, functionName: "balanceOf", args: [address] }),
      this.publicClient.getBalance({ address }),
    ]);
    return { address, usdc, mon };
  }

  /**
   * The one path every sponsored transaction takes: balance floor, simulation (so gas is only
   * spent on transactions the chain accepts), send, and wait for inclusion.
   */
  private async submit<T>(simulate: () => Promise<{ request: unknown; result: T }>): Promise<RelayResult & { result: T }> {
    if ((await this.balance()) < this.o.relayerFloorWei) {
      throw new RelayError(503, "relay is paused: relayer gas balance is below its floor");
    }
    let sim: { request: unknown; result: T };
    try {
      sim = await simulate();
    } catch (e) {
      throw new RelayError(422, revertReason(e));
    }
    const hash = await this.wallet.writeContract(sim.request as Parameters<typeof this.wallet.writeContract>[0]);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    // Simulation passed, so this is rare (e.g. funds moved in between), but a reverted
    // transaction must never be reported as done.
    if (receipt.status !== "success") {
      throw new RelayError(502, `transaction ${hash} reverted on chain; no USDC moved`);
    }
    return { hash, blockNumber: receipt.blockNumber, status: "success", explorerUrl: txUrl(this.o.d, hash), result: sim.result };
  }

  /** Validates, simulates and submits a direct gift; resolves once the chain has included it. */
  async relayGift(body: unknown): Promise<RelayResult> {
    const req = this.parseGift(body);
    const { result: _, ...out } = await this.submit(() =>
      this.publicClient.simulateContract({
        account: this.account,
        address: this.o.d.beamGifts,
        abi: beamGiftsAbi,
        functionName: "giftCreator",
        args: [req.to, req.meta, req.auth],
      }),
    );
    return out;
  }

  /** Creates a gift-a-chatter drop or a Beam Bomb from the sender's signed authorization. */
  async relayDrop(body: unknown): Promise<RelayResult & { dropId: Hex }> {
    const parsed = dropRequest.safeParse(body);
    if (!parsed.success) throw new RelayError(400, issues(parsed.error));
    const { kind, params, meta, auth } = parsed.data;
    const k = kind === "chatter" ? DropKind.Chatter : DropKind.Bomb;
    try {
      checkMeta(meta);
      checkDropParams(params, k, BigInt(Math.floor(Date.now() / 1000)));
    } catch (e) {
      throw new RelayError(400, (e as Error).message);
    }
    this.checkAuth(auth);
    const { result, ...out } = await this.submit(() =>
      this.publicClient.simulateContract({
        account: this.account,
        address: this.o.d.beamClaims,
        abi: beamClaimsAbi,
        functionName: kind === "chatter" ? "giftChatter" : "bomb",
        args: [params, meta, auth],
      }),
    );
    return { ...out, dropId: result };
  }

  /** Pays one slot of a drop to `recipient`, authorized by the slot's claim key. */
  async relayClaim(body: unknown): Promise<RelayResult & { amount: bigint }> {
    const parsed = claimRequest.safeParse(body);
    if (!parsed.success) throw new RelayError(400, issues(parsed.error));
    const { dropId, slot, recipient, proof, claimSig } = parsed.data;
    const drop = await this.drop(dropId);
    const out = await this.submit(() =>
      this.publicClient.simulateContract({
        account: this.account,
        address: this.o.d.beamClaims,
        abi: beamClaimsAbi,
        functionName: "claim",
        args: [dropId, slot, recipient, proof, claimSig],
      }),
    );
    const { result: _, ...rest } = out;
    return { ...rest, amount: drop.perSlot };
  }

  /** Returns everything still unclaimed in a drop to its sender, on the sender's signature. */
  async relayReclaim(body: unknown): Promise<RelayResult & { amount: bigint }> {
    const parsed = reclaimRequest.safeParse(body);
    if (!parsed.success) throw new RelayError(400, issues(parsed.error));
    const { dropId, deadline, senderSig } = parsed.data;
    const drop = await this.drop(dropId);
    const { result: _, ...out } = await this.submit(() =>
      this.publicClient.simulateContract({
        account: this.account,
        address: this.o.d.beamClaims,
        abi: beamClaimsAbi,
        functionName: "reclaimBySig",
        args: [dropId, deadline, senderSig],
      }),
    );
    return { ...out, amount: drop.remaining };
  }

  /** A drop's on-chain state. */
  async drop(dropId: Hex) {
    const [sender, expiry, slots, claimed, kind, closed, perSlot, remaining, slotRoot, claimedSlots] = await this.publicClient.readContract({
      address: this.o.d.beamClaims,
      abi: beamClaimsAbi,
      functionName: "drops",
      args: [dropId],
    });
    return { dropId, exists: sender !== zeroAddress, sender, expiry, slots, claimed, kind, closed, perSlot, remaining, slotRoot, claimedSlots };
  }

  async isSlotClaimed(dropId: Hex, slot: number): Promise<boolean> {
    return this.publicClient.readContract({ address: this.o.d.beamClaims, abi: beamClaimsAbi, functionName: "isSlotClaimed", args: [dropId, slot] });
  }

  private checkAuth(auth: { value: bigint; validBefore: bigint }) {
    if (auth.value < this.o.minGiftUnits) throw new RelayError(400, `gift is below the ${this.o.minGiftUnits} unit minimum`);
    if (auth.validBefore <= BigInt(Math.floor(Date.now() / 1000))) throw new RelayError(400, "authorization has expired");
  }

  parseGift(body: unknown): { to: Address; meta: GiftMeta; auth: Authorization } {
    const parsed = giftRequest.safeParse(body);
    if (!parsed.success) throw new RelayError(400, issues(parsed.error));
    const { to, meta, auth } = parsed.data;
    try {
      checkMeta(meta);
    } catch (e) {
      throw new RelayError(400, (e as Error).message);
    }
    this.checkAuth(auth);
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

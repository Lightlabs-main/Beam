import { EventEmitter } from "node:events";
import { type Deployment, beamClaimsAbi, beamGiftsAbi } from "@beam/shared";
import { type Log, createPublicClient, parseEventLogs, webSocket } from "viem";
import type { Gift } from "./feed.js";

type GiftLog = Log<bigint, number, false>;

/** How long to gather one transaction's logs; they arrive together from the same block. */
const TX_GROUP_MS = 60;

/**
 * Turns BeamGifts / BeamClaims logs into the same Gift rows the indexer produces (same ids), so
 * gifts from the chain push and from Envio can be merged and de-duplicated.
 */
export function giftsFromLogs(d: Deployment, logs: GiftLog[]): Gift[] {
  const id = (l: GiftLog) => `${d.chain.id}-${l.transactionHash!.toLowerCase()}-${l.logIndex}`;
  const seq = (l: GiftLog) => (BigInt(l.blockNumber!) * 1_000_000n + BigInt(l.logIndex!)).toString();
  const base = (l: GiftLog) => ({ id: id(l), seq: seq(l), blockNumber: Number(l.blockNumber), txHash: l.transactionHash!.toLowerCase() });

  const giftLogs = parseEventLogs({ abi: beamGiftsAbi, logs: logs.filter((l) => l.address.toLowerCase() === d.beamGifts.toLowerCase()) });
  const claimLogs = parseEventLogs({ abi: beamClaimsAbi, logs: logs.filter((l) => l.address.toLowerCase() === d.beamClaims.toLowerCase()) });

  // giftWithSplit emits GiftSent immediately followed by GiftSplit in the same transaction.
  const splits = new Map<string, { recipient: string; amount: string }[]>();
  for (const l of giftLogs) {
    if (l.eventName !== "GiftSplit") continue;
    const a = (l as unknown as { args: { recipients: readonly string[]; amounts: readonly bigint[] } }).args;
    splits.set(
      `${d.chain.id}-${l.transactionHash.toLowerCase()}-${l.logIndex - 1}`,
      a.recipients.map((r, i) => ({ recipient: r.toLowerCase(), amount: a.amounts[i]!.toString() })),
    );
  }

  const out: Gift[] = [];
  for (const l of giftLogs) {
    if (l.eventName !== "GiftSent") continue;
    const a = l.args;
    const g = base(l);
    out.push({
      ...g,
      kind: splits.has(g.id) ? "Split" : "Direct",
      ...(splits.has(g.id) ? { payouts: splits.get(g.id) } : {}),
      from: a.from.toLowerCase(),
      channel: a.to.toLowerCase(),
      to: a.to.toLowerCase(),
      amount: a.amount.toString(),
      displayName: a.displayName,
      message: a.message,
      actionCode: Number(a.actionCode),
      dropId: null,
      recipientLabel: null,
      slots: null,
      ts: a.ts.toString(),
    });
  }
  for (const l of claimLogs) {
    if (l.eventName === "ChatterGiftSent") {
      const a = l.args;
      out.push({
        ...base(l),
        kind: "Chatter",
        from: a.from.toLowerCase(),
        channel: a.channel.toLowerCase(),
        to: null,
        amount: a.amount.toString(),
        displayName: a.displayName,
        message: a.message,
        actionCode: Number(a.actionCode),
        dropId: a.dropId,
        recipientLabel: a.recipientLabel,
        slots: 1,
        ts: a.ts.toString(),
      });
    } else if (l.eventName === "BombSent") {
      const a = l.args;
      out.push({
        ...base(l),
        kind: "Bomb",
        from: a.from.toLowerCase(),
        channel: a.channel.toLowerCase(),
        to: null,
        amount: a.pool.toString(),
        displayName: a.displayName,
        message: a.message,
        actionCode: Number(a.actionCode),
        dropId: a.bombId,
        recipientLabel: null,
        slots: Number(a.slots),
        ts: a.ts.toString(),
      });
    }
  }
  return out.sort((x, y) => (BigInt(x.seq) < BigInt(y.seq) ? -1 : 1));
}

/** A chatter (or bomb share) being claimed; routed to the stream its drop belongs to. */
export type ClaimEvent = { id: string; dropId: string; slot: number; recipient: string; amount: string; ts: string; txHash: string };

export function claimsFromLogs(d: Deployment, logs: GiftLog[]): ClaimEvent[] {
  return parseEventLogs({ abi: beamClaimsAbi, logs: logs.filter((l) => l.address.toLowerCase() === d.beamClaims.toLowerCase()) })
    .filter((l) => l.eventName === "Claimed")
    .map((l) => {
      const a = (l as unknown as { args: { dropId: string; slot: number; recipient: string; amount: bigint; ts: bigint } }).args;
      return {
        id: `${d.chain.id}-${l.transactionHash.toLowerCase()}-${l.logIndex}`,
        dropId: a.dropId.toLowerCase(),
        slot: Number(a.slot),
        recipient: a.recipient.toLowerCase(),
        amount: a.amount.toString(),
        ts: a.ts.toString(),
        txHash: l.transactionHash.toLowerCase(),
      };
    });
}

/**
 * Pushes Beam gifts the moment the chain emits them, from an `eth_subscribe` log subscription on
 * a Monad WebSocket endpoint: push, not polling, and free when idle. Envio's stream stays as the
 * backup source; the server de-duplicates by gift id.
 */
export class ChainGiftFeed extends EventEmitter<{ gift: [Gift]; claim: [ClaimEvent]; status: [string]; error: [Error] }> {
  private unwatch: () => void = () => {};
  /** subscribed → connected (first logs seen) ⇄ reconnecting. */
  status = "starting";

  constructor(
    private readonly d: Deployment,
    private readonly wsUrl: string,
  ) {
    super();
  }

  start(): this {
    const client = createPublicClient({
      chain: this.d.chain,
      transport: webSocket(this.wsUrl, { reconnect: { attempts: Infinity, delay: 1000 }, keepAlive: { interval: 20_000 } }),
    });
    // The subscription delivers logs one at a time, but a split gift is two logs (GiftSent, then
    // GiftSplit) in one transaction. Group each transaction's logs for a moment before reading them.
    const pending = new Map<string, GiftLog[]>();
    const flush = (tx: string) => {
      const logs = pending.get(tx) ?? [];
      pending.delete(tx);
      for (const gift of giftsFromLogs(this.d, logs)) this.emit("gift", gift);
      for (const claim of claimsFromLogs(this.d, logs)) this.emit("claim", claim);
    };
    this.unwatch = client.watchEvent({
      address: [this.d.beamGifts, this.d.beamClaims],
      onLogs: (logs) => {
        this.setStatus("connected");
        for (const log of logs as GiftLog[]) {
          const tx = log.transactionHash!;
          const group = pending.get(tx);
          if (group) group.push(log);
          else {
            pending.set(tx, [log]);
            setTimeout(() => flush(tx), TX_GROUP_MS);
          }
        }
      },
      onError: (e) => {
        this.setStatus("reconnecting");
        this.emit("error", e);
        // viem reopens the socket and resubscribes by itself; on a quiet chain no log arrives to
        // prove it, so probe the same socket until it answers again.
        if (this.probe) return;
        this.probe = setInterval(() => {
          void client
            .getBlockNumber()
            .then(() => {
              clearInterval(this.probe);
              this.probe = undefined;
              if (this.status === "reconnecting") this.setStatus("subscribed");
            })
            .catch(() => {});
        }, 10_000);
      },
    });
    this.setStatus("subscribed");
    return this;
  }

  private probe: ReturnType<typeof setInterval> | undefined;

  private setStatus(s: string) {
    this.status = s;
    this.emit("status", s);
  }

  close() {
    this.unwatch();
  }
}

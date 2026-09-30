import { EventEmitter } from "node:events";
import { type Deployment, beamClaimsAbi, beamGiftsAbi } from "@beam/shared";
import { type Log, createPublicClient, parseEventLogs, webSocket } from "viem";
import type { Gift } from "./feed.js";

type GiftLog = Log<bigint, number, false>;

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
  const splitGiftIds = new Set(
    giftLogs.filter((l) => l.eventName === "GiftSplit").map((l) => `${d.chain.id}-${l.transactionHash.toLowerCase()}-${l.logIndex - 1}`),
  );

  const out: Gift[] = [];
  for (const l of giftLogs) {
    if (l.eventName !== "GiftSent") continue;
    const a = l.args;
    const g = base(l);
    out.push({
      ...g,
      kind: splitGiftIds.has(g.id) ? "Split" : "Direct",
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

/**
 * Pushes Beam gifts the moment the chain emits them, from an `eth_subscribe` log subscription on
 * a Monad WebSocket endpoint: push, not polling, and free when idle. Envio's stream stays as the
 * backup source; the server de-duplicates by gift id.
 */
export class ChainGiftFeed extends EventEmitter<{ gift: [Gift]; status: [string]; error: [Error] }> {
  private unwatch: () => void = () => {};

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
    this.unwatch = client.watchEvent({
      address: [this.d.beamGifts, this.d.beamClaims],
      onLogs: (logs) => {
        this.emit("status", "connected");
        for (const gift of giftsFromLogs(this.d, logs as GiftLog[])) this.emit("gift", gift);
      },
      onError: (e) => {
        this.emit("status", "reconnecting");
        this.emit("error", e);
      },
    });
    this.emit("status", "subscribed");
    return this;
  }

  close() {
    this.unwatch();
  }
}

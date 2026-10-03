import { EventEmitter } from "node:events";
import { createClient } from "graphql-ws";
import WebSocket from "ws";

/** A gift exactly as indexed from the chain; integers arrive as decimal strings. */
export type Gift = {
  id: string;
  seq: string;
  kind: "Direct" | "Split" | "Chatter" | "Bomb";
  from: string;
  /** The creator whose stream this happened on; overlays subscribe by it. */
  channel: string;
  /** The creator paid, for Direct/Split; null for claimable drops. */
  to: string | null;
  amount: string;
  displayName: string;
  message: string;
  actionCode: number;
  dropId: string | null;
  recipientLabel: string | null;
  slots: number | null;
  ts: string;
  blockNumber: number;
  txHash: string;
  /** Split gifts from the chain push: who got what, in the same transaction. */
  payouts?: { recipient: string; amount: string }[];
};

/** A wallet-centric row assembled from the indexed on-chain entities. */
export type AccountActivity = {
  id: string;
  kind: "received" | "sent" | "claimed" | "reclaimed";
  giftKind: Gift["kind"] | "Claim" | "Reclaim";
  amount: string;
  displayName: string;
  message: string;
  ts: string;
  txHash: string;
  counterpart: string | null;
  dropId: string | null;
  status: "settled" | "pending" | "refunded";
};

const GIFT_FIELDS = `id seq kind from channel to amount displayName message actionCode dropId recipientLabel slots ts blockNumber txHash`;

// Hasura returns numeric columns as numbers or strings depending on its settings; normalise.
const normalise = (g: Record<string, unknown>): Gift =>
  ({ ...g, seq: String(g.seq), amount: String(g.amount), ts: String(g.ts) }) as Gift;

export type GraphqlOptions = { httpUrl: string; wsUrl: string; adminSecret: string };

export class Indexed {
  constructor(private readonly o: GraphqlOptions) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.o.httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hasura-admin-secret": this.o.adminSecret },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length || !body.data) {
      throw new Error(`indexer query failed: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
    }
    return body.data;
  }

  /** Everything that happened on a creator's stream: gifts to them, chatter gifts and bombs. */
  async recentGifts(creator: string, limit: number): Promise<Gift[]> {
    const data = await this.query<{ Gift: Record<string, unknown>[] }>(
      `query ($channel: String!, $limit: Int!) {
        Gift(where: { channel: { _eq: $channel } }, order_by: { seq: desc }, limit: $limit) { ${GIFT_FIELDS} }
      }`,
      { channel: creator.toLowerCase(), limit },
    );
    return data.Gift.map(normalise);
  }

  /** The gift row that created a drop (name, message, label, channel), once indexed. */
  async giftByDrop(dropId: string): Promise<Gift | null> {
    const data = await this.query<{ Gift: Record<string, unknown>[] }>(
      `query ($dropId: String!) { Gift(where: { dropId: { _eq: $dropId } }, limit: 1) { ${GIFT_FIELDS} } }`,
      { dropId: dropId.toLowerCase() },
    );
    return data.Gift[0] ? normalise(data.Gift[0]) : null;
  }

  /**
   * USDC base units a creator actually received at or after `sinceTs` (unix seconds): direct gifts
   * in full, and only their own share of split gifts (as the primary or as someone else's share).
   */
  async totalSince(creator: string, sinceTs: bigint): Promise<bigint> {
    type Agg = { aggregate: { count: number; sum: { amount: string | number | null } } };
    const data = await this.query<{ direct: Agg; shares: Agg }>(
      `query ($c: String!, $since: numeric!) {
        direct: Gift_aggregate(where: { to: { _eq: $c }, kind: { _eq: "Direct" }, ts: { _gte: $since } }) { aggregate { count sum { amount } } }
        shares: SplitPayout_aggregate(where: { recipient: { _eq: $c }, ts: { _gte: $since } }) { aggregate { count sum { amount } } }
      }`,
      { c: creator.toLowerCase(), since: sinceTs.toString() },
    );
    const n = (a: Agg) => (a.aggregate.sum.amount === null ? 0n : BigInt(String(a.aggregate.sum.amount)));
    return n(data.direct) + n(data.shares);
  }

  /** A creator's earnings: what they received in total, and their latest gifts with their share of each. */
  async earnings(creator: string, limit: number) {
    type Agg = { aggregate: { count: number; sum: { amount: string | number | null } } };
    const c = creator.toLowerCase();
    const summary = await this.query<{
      direct: Agg;
      shares: Agg;
      payouts: { giftId: string; amount: string | number }[];
    }>(
      `query ($c: String!) {
        direct: Gift_aggregate(where: { to: { _eq: $c }, kind: { _eq: "Direct" } }) { aggregate { count sum { amount } } }
        shares: SplitPayout_aggregate(where: { recipient: { _eq: $c } }) { aggregate { count sum { amount } } }
        payouts: SplitPayout(where: { recipient: { _eq: $c } }, order_by: { ts: desc }, limit: 100) { giftId amount }
      }`,
      { c },
    );
    const data = await this.query<{ gifts: Record<string, unknown>[] }>(
      `query ($c: String!, $ids: [ID!]!, $limit: Int!) {
        gifts: Gift(where: { _or: [{ to: { _eq: $c } }, { id: { _in: $ids } }] }, order_by: { seq: desc }, limit: $limit) { ${GIFT_FIELDS} }
      }`,
      { c, ids: summary.payouts.map((p) => p.giftId), limit },
    );
    const n = (a: Agg) => (a.aggregate.sum.amount === null ? 0n : BigInt(String(a.aggregate.sum.amount)));
    const share = new Map(summary.payouts.map((p) => [p.giftId, String(p.amount)]));
    return {
      total: n(summary.direct) + n(summary.shares),
      gifts: summary.direct.aggregate.count + summary.shares.aggregate.count,
      recent: data.gifts.map(normalise).map((g) => ({ ...g, received: g.kind === "Split" ? (share.get(g.id) ?? null) : g.amount })),
    };
  }

  /**
   * A wallet's complete indexed activity. This is deliberately assembled from event entities so
   * it remains useful for passkey wallets that have no account or session on the server.
   */
  async accountActivity(address: string, limit: number): Promise<AccountActivity[]> {
    const c = address.toLowerCase();
    type Row = Record<string, unknown>;
    const data = await this.query<{
      gifts: Row[];
      payouts: Row[];
      claims: Row[];
      reclaims: Row[];
    }>(
      `query ($c: String!, $limit: Int!) {
        gifts: Gift(where: { _or: [{ from: { _eq: $c } }, { to: { _eq: $c } }] }, order_by: { seq: desc }, limit: $limit) { ${GIFT_FIELDS} }
        payouts: SplitPayout(where: { recipient: { _eq: $c } }, order_by: { ts: desc }, limit: $limit) { id giftId amount from ts txHash }
        claims: Claim(where: { recipient: { _eq: $c } }, order_by: { seq: desc }, limit: $limit) { id dropId amount slot ts txHash }
        reclaims: Reclaim(where: { sender: { _eq: $c } }, order_by: { ts: desc }, limit: $limit) { id dropId amount expired ts txHash }
      }`,
      { c, limit },
    );
    const gifts = data.gifts.map(normalise);
    const byId = new Map(gifts.map((g) => [g.id, g]));
    const missingGiftIds = [...new Set(data.payouts.map((p) => String(p.giftId)).filter((id) => !byId.has(id)))];
    if (missingGiftIds.length) {
      const extra = await this.query<{ gifts: Row[] }>(
        `query ($ids: [ID!]!) {
          gifts: Gift(where: { id: { _in: $ids } }) { ${GIFT_FIELDS} }
        }`,
        { ids: missingGiftIds },
      );
      for (const gift of extra.gifts.map(normalise)) byId.set(gift.id, gift);
    }
    const out: AccountActivity[] = [];
    for (const g of gifts) {
      const isSent = g.from.toLowerCase() === c && g.to?.toLowerCase() !== c;
      if (isSent) {
        out.push({
          id: g.id,
          kind: "sent",
          giftKind: g.kind,
          amount: g.amount,
          displayName: g.displayName,
          message: g.message,
          ts: g.ts,
          txHash: g.txHash,
          counterpart: g.channel,
          dropId: g.dropId,
          status: g.kind === "Chatter" || g.kind === "Bomb" ? "pending" : "settled",
        });
      } else if (g.kind === "Direct" && g.to?.toLowerCase() === c) {
        out.push({
          id: g.id,
          kind: "received",
          giftKind: g.kind,
          amount: g.amount,
          displayName: g.displayName,
          message: g.message,
          ts: g.ts,
          txHash: g.txHash,
          counterpart: g.from,
          dropId: null,
          status: "settled",
        });
      }
    }
    for (const p of data.payouts) {
      const gift = byId.get(String(p.giftId));
      out.push({
        id: String(p.id),
        kind: "received",
        giftKind: "Split",
        amount: String(p.amount),
        displayName: gift?.displayName ?? "Split gift",
        message: gift?.message ?? "",
        ts: String(p.ts),
        txHash: String(p.txHash),
        counterpart: String(p.from),
        dropId: null,
        status: "settled",
      });
    }
    for (const claim of data.claims) {
      out.push({
        id: String(claim.id),
        kind: "claimed",
        giftKind: "Claim",
        amount: String(claim.amount),
        displayName: "Beam claim",
        message: "",
        ts: String(claim.ts),
        txHash: String(claim.txHash),
        counterpart: null,
        dropId: String(claim.dropId),
        status: "settled",
      });
    }
    for (const reclaim of data.reclaims) {
      out.push({
        id: String(reclaim.id),
        kind: "reclaimed",
        giftKind: "Reclaim",
        amount: String(reclaim.amount),
        displayName: "Returned drop",
        message: "",
        ts: String(reclaim.ts),
        txHash: String(reclaim.txHash),
        counterpart: null,
        dropId: String(reclaim.dropId),
        status: "refunded",
      });
    }
    return out.sort((a, b) => Number(BigInt(b.ts) - BigInt(a.ts))).slice(0, limit);
  }

  async latestSeq(): Promise<string> {
    const data = await this.query<{ Gift: { seq: string | number }[] }>(`{ Gift(order_by: { seq: desc }, limit: 1) { seq } }`);
    return data.Gift[0] ? String(data.Gift[0].seq) : "0";
  }

  /**
   * Emits every gift indexed after start-up, in chain order, from a Hasura streaming
   * subscription. The cursor is `seq`, so a reconnect resumes where it left off. Returns at
   * once; until the indexer's tables exist it keeps retrying and reports status "waiting".
   */
  streamGifts(): GiftStream {
    const stream = new GiftStream();
    let closed = false;
    stream.close = () => {
      closed = true;
    };

    const start = async () => {
      let cursor: string;
      for (;;) {
        if (closed) return;
        try {
          cursor = await this.latestSeq();
          break;
        } catch (e) {
          stream.emit("status", "waiting");
          stream.emit("error", e as Error);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      this.subscribeFrom(stream, cursor, () => closed);
    };
    void start();
    return stream;
  }

  private subscribeFrom(stream: GiftStream, initialCursor: string, isClosed: () => boolean) {
    let cursor = initialCursor;
    const client = createClient({
      url: this.o.wsUrl,
      webSocketImpl: WebSocket,
      connectionParams: { headers: { "x-hasura-admin-secret": this.o.adminSecret } },
      retryAttempts: Infinity,
      shouldRetry: () => true,
      on: {
        connected: () => stream.emit("status", "connected"),
        closed: () => stream.emit("status", "disconnected"),
      },
    });

    const subscribe = () =>
      client.subscribe<{ Gift_stream: Record<string, unknown>[] }>(
        {
          query: `subscription ($seq: numeric!) {
            Gift_stream(batch_size: 100, cursor: { initial_value: { seq: $seq }, ordering: ASC }) { ${GIFT_FIELDS} }
          }`,
          variables: { seq: cursor },
        },
        {
          next: ({ data, errors }) => {
            if (errors?.length) return stream.emit("error", new Error(errors.map((e) => e.message).join("; ")));
            for (const raw of data?.Gift_stream ?? []) {
              const gift = normalise(raw);
              // Streaming cursors are inclusive of the initial value on (re)subscribe.
              if (BigInt(gift.seq) <= BigInt(cursor)) continue;
              cursor = gift.seq;
              stream.emit("gift", gift);
            }
          },
          error: (e) => {
            stream.emit("error", e instanceof Error ? e : new Error(JSON.stringify(e)));
            setTimeout(() => {
              if (!isClosed()) unsubscribe = subscribe();
            }, 3000);
          },
          complete: () => {},
        },
      );

    let unsubscribe = subscribe();
    stream.close = () => {
      unsubscribe();
      void client.dispose();
    };
  }
}

export class GiftStream extends EventEmitter<{ gift: [Gift]; status: [string]; error: [Error] }> {
  close: () => void = () => {};
}

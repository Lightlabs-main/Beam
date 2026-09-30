import { EventEmitter } from "node:events";
import { createClient } from "graphql-ws";
import WebSocket from "ws";

/** A gift exactly as indexed from the chain; integers arrive as decimal strings. */
export type Gift = {
  id: string;
  seq: string;
  kind: "Direct" | "Split" | "Chatter" | "Bomb";
  from: string;
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
};

const GIFT_FIELDS = `id seq kind from to amount displayName message actionCode dropId recipientLabel slots ts blockNumber txHash`;

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

  async recentGifts(creator: string, limit: number): Promise<Gift[]> {
    const data = await this.query<{ Gift: Record<string, unknown>[] }>(
      `query ($to: String!, $limit: Int!) {
        Gift(where: { to: { _eq: $to } }, order_by: { seq: desc }, limit: $limit) { ${GIFT_FIELDS} }
      }`,
      { to: creator.toLowerCase(), limit },
    );
    return data.Gift.map(normalise);
  }

  /** Total USDC base units a creator received from gifts at or after `sinceTs` (unix seconds). */
  async totalSince(creator: string, sinceTs: bigint): Promise<bigint> {
    const data = await this.query<{ Gift_aggregate: { aggregate: { sum: { amount: string | number | null } } } }>(
      `query ($to: String!, $since: numeric!) {
        Gift_aggregate(where: { to: { _eq: $to }, ts: { _gte: $since } }) { aggregate { sum { amount } } }
      }`,
      { to: creator.toLowerCase(), since: sinceTs.toString() },
    );
    const sum = data.Gift_aggregate.aggregate.sum.amount;
    return sum === null ? 0n : BigInt(String(sum));
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

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { formatUsdc } from "@beam/shared";
import { isAddress } from "viem";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import type { ChainGiftFeed } from "./chainfeed.js";
import type { Gift, GiftStream, Indexed } from "./feed.js";
import { RelayError, type Relayer } from "./relayer.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

type Deps = { config: Config; relayer: Relayer; indexed: Indexed; gifts: GiftStream; chain: ChainGiftFeed };

/** Gifts older than this when they reach the feed are history being re-indexed, not live. */
const LIVE_WINDOW_MS = 60_000;

export function createApp({ config, relayer, indexed, gifts, chain }: Deps) {
  const { d } = config;
  const trustProxy = process.env.TRUST_PROXY === "1";
  const clientIp = (req: IncomingMessage) =>
    (trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "";

  // Fixed one-minute window per client IP for relay requests: sponsorship is bounded.
  const windows = new Map<string, { start: number; count: number }>();
  // Forget finished windows so memory stays bounded by the last minute of visitors.
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [ip, w] of windows) if (w.start < cutoff) windows.delete(ip);
  }, 60_000).unref();
  const allowRelay = (ip: string) => {
    const now = Date.now();
    const w = windows.get(ip);
    if (!w || now - w.start >= 60_000) {
      windows.set(ip, { start: now, count: 1 });
      return true;
    }
    return ++w.count <= config.relayPerMinute;
  };

  let indexerStatus = "connecting";
  gifts.on("status", (s) => (indexerStatus = s));
  let lastFeedError = "";
  gifts.on("error", (e) => {
    if (e.message !== lastFeedError) console.error(`[feed] ${e.message}`);
    lastFeedError = e.message;
  });
  gifts.on("status", (s) => s === "connected" && (lastFeedError = ""));

  let lastChainError = "";
  chain.on("error", (e) => {
    if (e.message !== lastChainError) console.error(`[chain] ${e.message}`);
    lastChainError = e.message;
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  };

  const readBody = (req: IncomingMessage, limit = 16_384) =>
    new Promise<unknown>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new RelayError(413, "request body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new RelayError(400, "body must be JSON"));
        }
      });
      req.on("error", reject);
    });

  async function serveStatic(pathname: string, res: ServerResponse) {
    const route = pathname === "/overlay" ? "/overlay.html" : pathname === "/" ? "/index.html" : pathname;
    const file = normalize(join(config.webDir, route));
    if (!file.startsWith(normalize(config.webDir))) return json(res, 404, { error: "not found" });
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": route.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      createReadStream(file).pipe(res);
    } catch {
      json(res, 404, { error: "not found" });
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/healthz") {
        const balance = await relayer.balance();
        return json(res, 200, {
          network: d.network,
          chainId: d.chain.id,
          relayer: relayer.address,
          relayerBalanceWei: balance,
          relayerAboveFloor: balance >= config.relayerFloorWei,
          indexer: indexerStatus,
          chainPush: chain.status,
        });
      }
      if (req.method === "GET" && path === "/api/config") {
        return json(res, 200, {
          network: d.network,
          chainId: d.chain.id,
          usdc: d.usdc,
          beamGifts: d.beamGifts,
          beamClaims: d.beamClaims,
          explorer: d.explorer,
          minGiftUsdc: formatUsdc(config.minGiftUnits),
        });
      }
      if (req.method === "POST" && path === "/api/relay/gift") {
        if (!allowRelay(clientIp(req))) return json(res, 429, { error: "too many gifts from this address, try again in a minute" });
        return json(res, 200, await relayer.relayGift(await readBody(req)));
      }
      const creatorRoute = /^\/api\/creators\/(0x[0-9a-fA-F]{40})\/(gifts|total)$/.exec(path);
      if (req.method === "GET" && creatorRoute) {
        const [, creator, what] = creatorRoute as unknown as [string, string, string];
        if (what === "gifts") {
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 10), 1), 50);
          return json(res, 200, { gifts: await indexed.recentGifts(creator, limit) });
        }
        const since = url.searchParams.get("since");
        if (!since || !/^\d+$/.test(since)) return json(res, 400, { error: "since must be a unix timestamp" });
        return json(res, 200, { total: await indexed.totalSince(creator, BigInt(since)) });
      }
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(path, res);
      json(res, 405, { error: "method not allowed" });
    } catch (e) {
      if (e instanceof RelayError) return json(res, e.status, { error: e.message });
      console.error(e);
      json(res, 500, { error: "internal error" });
    }
  });

  // Overlays subscribe per creator: ws(s)://host/ws?creator=0x...
  const wss = new WebSocketServer({ noServer: true });
  const byCreator = new Map<string, Set<WebSocket>>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const creator = url.searchParams.get("creator") ?? "";
    if (url.pathname !== "/ws" || !isAddress(creator)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const key = creator.toLowerCase();
      const set = byCreator.get(key) ?? new Set();
      set.add(ws);
      byCreator.set(key, set);
      ws.send(JSON.stringify({ type: "hello", indexer: indexerStatus }));
      const ping = setInterval(() => ws.ping(), 25_000);
      ws.on("close", () => {
        clearInterval(ping);
        set.delete(ws);
        if (set.size === 0) byCreator.delete(key);
      });
    });
  });

  // Two sources carry the same gifts: the chain's log push (first, usually) and Envio (backup).
  // Whichever delivers a gift first fires the alert; the other copy is dropped by id.
  const delivered = new Map<string, number>();
  setInterval(() => {
    const cutoff = Date.now() - 10 * LIVE_WINDOW_MS;
    for (const [id, at] of delivered) if (at < cutoff) delivered.delete(id);
  }, LIVE_WINDOW_MS).unref();

  const onGift = (source: "chain" | "indexer") => (gift: Gift) => {
    const receivedAt = Date.now();
    if (delivered.has(gift.id)) {
      console.log(`[${source}] ${gift.txHash} +${receivedAt - delivered.get(gift.id)!}ms after first delivery (duplicate)`);
      return;
    }
    const lag = receivedAt - Number(gift.ts) * 1000;
    // A (re)syncing indexer streams old gifts too. Alerts are for gifts happening now; history
    // reaches overlays through the recent/total queries they run on connect.
    const backfill = lag > LIVE_WINDOW_MS;
    const targets = byCreator.get(gift.channel.toLowerCase());
    if (!backfill) delivered.set(gift.id, receivedAt);
    console.log(
      `[${source}] ${gift.kind} ${gift.txHash} ${formatUsdc(BigInt(gift.amount))} USDC -> ${gift.to ?? gift.recipientLabel ?? "drop"} on ${gift.channel} ` +
        `(block ts + ${lag}ms, ${backfill ? "backfill, not alerted" : `${targets?.size ?? 0} overlays`})`,
    );
    if (!targets || backfill) return;
    const msg = JSON.stringify({ type: "gift", gift });
    for (const ws of targets) if (ws.readyState === ws.OPEN) ws.send(msg);
  };
  chain.on("gift", onGift("chain"));
  gifts.on("gift", onGift("indexer"));

  return server;
}

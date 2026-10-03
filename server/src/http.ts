import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { formatUsdc } from "@beam/shared";
import { isAddress } from "viem";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import type { ChainGiftFeed, ClaimEvent } from "./chainfeed.js";
import type { CreatorStore } from "./creators.js";
import type { BeamBot } from "./twitch.js";
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

type Deps = {
  config: Config;
  relayer: Relayer;
  indexed: Indexed;
  gifts: GiftStream;
  chain: ChainGiftFeed;
  creators: CreatorStore;
  bot: BeamBot | null;
};

/** Gifts older than this when they reach the feed are history being re-indexed, not live. */
const LIVE_WINDOW_MS = 60_000;

export function createApp({ config, relayer, indexed, gifts, chain, creators, bot }: Deps) {
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

  // Drop-creating gifts seen live, so a claim link opened seconds later can show who sent it.
  const recentDrops = new Map<string, Gift>();
  const rememberDrop = (g: Gift) => {
    recentDrops.set(g.dropId!.toLowerCase(), g);
    if (recentDrops.size > 1000) recentDrops.delete(recentDrops.keys().next().value!);
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

  const oauthStates = new Map<string, number>();
  const linkStates = new Map<string, { creator: string; expires: number }>();
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const page = (res: ServerResponse, status: number, title: string, body: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Beam · ${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0a14;color:#f4f3fa;` +
        `font:16px/1.5 system-ui,sans-serif;text-align:center;padding:16px}a{color:#22d3ee}</style></head>` +
        `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="/">beamstreams.xyz</a></p></main></body></html>`,
    );
  };

  const notFound = (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers.accept ?? "").includes("text/html")) return json(res, 404, { error: "not found" });
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Beam · Page not found</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0a14;color:#f4f3fa;` +
        `font:16px/1.5 system-ui,sans-serif;text-align:center;padding:16px}a{color:#22d3ee}</style></head>` +
        `<body><main><h1>Nothing here</h1><p>This page doesn't exist on Beam.</p><p><a href="/">Go to beamstreams.xyz</a></p></main></body></html>`,
    );
  };

  async function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse) {
    const route =
      pathname === "/"
        ? "/index.html"
        : pathname === "/overlay"
          ? "/overlay.html"
          : pathname === "/wallet"
            ? "/wallet.html"
            : pathname === "/creator"
              ? "/creator.html"
              : pathname === "/studio"
                ? "/studio.html"
                : pathname === "/earnings"
                  ? "/earnings.html"
            : /^\/g\/0x[0-9a-fA-F]{40}\/?$/.test(pathname)
              ? "/gift.html"
              : /^\/c\/0x[0-9a-fA-F]{64}\/?$/.test(pathname)
                ? "/claim.html"
                : /^\/watch\/0x[0-9a-fA-F]{40}\/?$/.test(pathname)
                  ? "/watch.html"
                : pathname;
    const file = normalize(join(config.webDir, route));
    if (!file.startsWith(normalize(config.webDir))) return notFound(req, res);
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": route.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      createReadStream(file).pipe(res);
    } catch {
      notFound(req, res);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    // These pages handle passkeys and recovery material. Keep the browser boundary explicit even
    // when the process is behind Caddy, and allow the watch page's known platform frames. The local
    // ws:// sources let the setup pages add the overlay to OBS on the streamer's own computer.
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("permissions-policy", "camera=(self), microphone=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)");
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https: wss: ws://127.0.0.1:* ws://localhost:*; frame-src 'self' https://player.twitch.tv https://www.twitch.tv https://www.youtube.com https://www.youtube-nocookie.com https://player.kick.com https://kick.com",
    );
    try {
      if (req.method === "GET" && path === "/healthz") {
        const balance = await relayer.balance();
        const relayerAboveFloor = balance >= config.relayerFloorWei;
        const feedsConnected = indexerStatus === "connected" && ["subscribed", "connected"].includes(chain.status);
        const healthy = relayerAboveFloor && feedsConnected;
        return json(res, healthy ? 200 : 503, {
          network: d.network,
          chainId: d.chain.id,
          relayer: relayer.address,
          relayerBalanceWei: balance,
          relayerAboveFloor,
          indexer: indexerStatus,
          chainPush: chain.status,
          healthy,
          twitchBot: bot ? bot.status : "not configured",
        });
      }
      // Connect Beam's Twitch bot account (admin only, once): Twitch login → tokens kept on the volume.
      if (req.method === "GET" && path === "/twitch/bot/connect") {
        if (!bot || !config.twitch) return page(res, 503, "Twitch bot not configured", "Set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and TWITCH_BOT_ADMIN_KEY first.");
        if (url.searchParams.get("key") !== config.twitch.adminKey) return page(res, 403, "Not allowed", "That admin key is wrong.");
        const state = randomBytes(16).toString("hex");
        oauthStates.set(state, Date.now() + 10 * 60_000);
        res.writeHead(302, { location: bot.auth.authorizeUrl(state), "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "GET" && path === "/twitch/bot/callback") {
        const state = url.searchParams.get("state") ?? "";
        const expires = oauthStates.get(state);
        oauthStates.delete(state);
        if (!bot || !expires || expires < Date.now()) return page(res, 400, "Link expired", "Start again from the connect link.");
        const code = url.searchParams.get("code");
        if (!code) return page(res, 400, "Not connected", url.searchParams.get("error_description") ?? "Twitch did not return a code.");
        const login = await bot.auth.connect(code);
        await bot.start();
        return page(res, 200, "Beam bot connected", `Beam's chat bot is now ${login} on Twitch. Creators switch it on from /creator.`);
      }
      // A streamer proves they own their Twitch channel: Twitch login → channel paired with their wallet.
      if (req.method === "GET" && path === "/twitch/link/start") {
        const creator = url.searchParams.get("creator") ?? "";
        if (!bot) return page(res, 503, "Twitch isn't set up here yet", "Type your channel name on the setup page instead.");
        if (!isAddress(creator)) return page(res, 400, "Missing wallet", "Start from beamstreams.xyz/creator.");
        const state = randomBytes(16).toString("hex");
        linkStates.set(state, { creator, expires: Date.now() + 10 * 60_000 });
        res.writeHead(302, { location: bot.links.authorizeUrl(state), "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "GET" && path === "/twitch/link/callback") {
        const pending = linkStates.get(url.searchParams.get("state") ?? "");
        linkStates.delete(url.searchParams.get("state") ?? "");
        const code = url.searchParams.get("code");
        if (!bot || !pending || pending.expires < Date.now() || !code) {
          res.writeHead(302, { location: "/creator?twitch=failed" });
          return res.end();
        }
        const login = await bot.links.link(code, pending.creator);
        await bot.refreshChannels();
        res.writeHead(302, { location: `/creator?twitch=${encodeURIComponent(login)}` });
        return res.end();
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
          // Whether creators can switch on Beam's Twitch chat bot, and its name (to /mod it).
          twitchBot: bot?.auth.login ? { login: bot.auth.login } : null,
          // Connect Twitch works as soon as the Twitch app is configured, even before the bot is.
          twitchConnect: !!bot,
          fundingUrl: config.fundingUrl,
        });
      }
      if (req.method === "POST" && path === "/api/relay/gift") {
        if (!allowRelay(clientIp(req))) return json(res, 429, { error: "too many gifts from this address, try again in a minute" });
        return json(res, 200, await relayer.relayGift(await readBody(req)));
      }
      if (req.method === "POST" && path === "/api/relay/split") {
        if (!allowRelay(clientIp(req))) return json(res, 429, { error: "too many gifts from this address, try again in a minute" });
        return json(res, 200, await relayer.relaySplit(await readBody(req)));
      }
      const configRoute = /^\/api\/creators\/(0x[0-9a-fA-F]{40})\/config$/.exec(path);
      if (configRoute && req.method === "GET") {
        return json(res, 200, (await creators.get(configRoute[1]!)) ?? { config: null, signature: null });
      }
      if (configRoute && req.method === "PUT") {
        if (!allowRelay(clientIp(req))) return json(res, 429, { error: "too many requests from this address, try again in a minute" });
        return json(res, 200, await creators.put(configRoute[1]!, await readBody(req)));
      }
      if (req.method === "POST" && path === "/api/relay/drop") {
        if (!allowRelay(clientIp(req))) return json(res, 429, { error: "too many gifts from this address, try again in a minute" });
        return json(res, 200, await relayer.relayDrop(await readBody(req)));
      }
      if (req.method === "POST" && path === "/api/relay/claim") {
        if (!allowRelay(clientIp(req))) return json(res, 429, { error: "too many claims from this address, try again in a minute" });
        return json(res, 200, await relayer.relayClaim(await readBody(req)));
      }
      if (req.method === "POST" && path === "/api/relay/reclaim") {
        if (!allowRelay(clientIp(req))) return json(res, 429, { error: "too many requests from this address, try again in a minute" });
        return json(res, 200, await relayer.relayReclaim(await readBody(req)));
      }
      const dropRoute = /^\/api\/drops\/(0x[0-9a-fA-F]{64})$/.exec(path);
      if (req.method === "GET" && dropRoute) {
        const dropId = dropRoute[1] as `0x${string}`;
        const slot = Number(url.searchParams.get("slot") ?? 0);
        const [drop, slotClaimed, gift] = await Promise.all([
          relayer.drop(dropId),
          Number.isInteger(slot) && slot >= 0 && slot < 100 ? relayer.isSlotClaimed(dropId, slot) : Promise.resolve(false),
          // Sender's name and message: from the chain push if recent (the indexer can lag), else
          // the indexer. A nicety either way: the claim itself works from chain state alone.
          recentDrops.get(dropId.toLowerCase()) ?? indexed.giftByDrop(dropId).catch(() => null),
        ]);
        if (!drop.exists) return json(res, 404, { error: "no gift with this link exists" });
        return json(res, 200, {
          ...drop,
          slotClaimed,
          expired: Number(drop.expiry) * 1000 <= Date.now(),
          from: gift ? { name: gift.displayName, message: gift.message, recipientLabel: gift.recipientLabel, channel: gift.channel } : null,
        });
      }
      // Setup progress for /creator: is this creator's overlay open somewhere (OBS, Studio) right now?
      const statusRoute = /^\/api\/creators\/(0x[0-9a-fA-F]{40})\/status$/.exec(path);
      if (req.method === "GET" && statusRoute) {
        return json(res, 200, {
          overlays: byCreator.get(statusRoute[1]!.toLowerCase())?.size ?? 0,
          // The Twitch channel this wallet proved it owns (Connect Twitch), if any.
          twitch: bot?.links.channelOf(statusRoute[1]!) ?? null,
        });
      }
      const earningsRoute = /^\/api\/creators\/(0x[0-9a-fA-F]{40})\/earnings$/.exec(path);
      if (req.method === "GET" && earningsRoute) {
        const creator = earningsRoute[1] as `0x${string}`;
        const [earnings, wallet] = await Promise.all([indexed.earnings(creator, 30), relayer.balances(creator)]);
        return json(res, 200, { ...earnings, balance: wallet.usdc, explorer: `${d.explorer}/address/${creator}` });
      }
      const accountRoute = /^\/api\/accounts\/(0x[0-9a-fA-F]{40})$/.exec(path);
      if (req.method === "GET" && accountRoute) {
        return json(res, 200, await relayer.balances(accountRoute[1] as `0x${string}`));
      }
      const activityRoute = /^\/api\/accounts\/(0x[0-9a-fA-F]{40})\/activity$/.exec(path);
      if (req.method === "GET" && activityRoute) {
        const limitRaw = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        return json(res, 200, { activity: await indexed.accountActivity(activityRoute[1]!, limit) });
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
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(path, req, res);
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
    if (gift.dropId) rememberDrop(gift);
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
    if (backfill) return;
    bot?.announceGift(gift);
    if (!targets) return;
    const msg = JSON.stringify({ type: "gift", gift });
    for (const ws of targets) if (ws.readyState === ws.OPEN) ws.send(msg);
  };
  chain.on("gift", onGift("chain"));

  // A claim tells the stream that a walletless chatter really got paid. Claimed events don't carry
  // the channel, so it comes from the drop's creating gift (seen live, else from the indexer).
  chain.on("claim", async (claim: ClaimEvent) => {
    if (Date.now() - Number(claim.ts) * 1000 > LIVE_WINDOW_MS) return;
    const drop = recentDrops.get(claim.dropId) ?? (await indexed.giftByDrop(claim.dropId).catch(() => null));
    if (!drop) return console.log(`[chain] claim ${claim.txHash} for unknown drop ${claim.dropId}`);
    const targets = byCreator.get(drop.channel.toLowerCase());
    console.log(`[chain] claim ${claim.txHash} ${formatUsdc(BigInt(claim.amount))} USDC of ${drop.kind} on ${drop.channel} (${targets?.size ?? 0} overlays)`);
    bot?.announceClaim({ ...claim, kind: drop.kind, from: drop.displayName, recipientLabel: drop.recipientLabel }, drop.channel);
    if (!targets) return;
    const msg = JSON.stringify({
      type: "claim",
      claim: { ...claim, kind: drop.kind, from: drop.displayName, recipientLabel: drop.recipientLabel },
    });
    for (const ws of targets) if (ws.readyState === ws.OPEN) ws.send(msg);
  });
  gifts.on("gift", onGift("indexer"));

  return server;
}

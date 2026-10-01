import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatUsdc, usdLabel } from "@beam/shared";
import WebSocket from "ws";
import type { CreatorStore, SignedConfig } from "./creators.js";
import type { ClaimEvent } from "./chainfeed.js";
import type { Gift } from "./feed.js";

/**
 * Beam's Twitch chat bot. One bot account, joined to every channel whose creator switched it on
 * (a signed setting). It answers !gift with the creator's gift link, answers !gift @user [amount]
 * with a ready-made link to gift that chatter, and announces gifts and claims in chat (spec 6.2).
 */

export type TwitchOptions = {
  clientId: string;
  clientSecret: string;
  /** e.g. https://beamstreams.xyz: links in chat and the OAuth redirect. */
  publicUrl: string;
  dataDir: string;
};

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; login: string };

const SCOPES = "chat:read chat:edit";

// ------------------------------------------------------------------ auth

async function tokenRequest(o: TwitchOptions, params: Record<string, string>) {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, ...params }),
  });
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; message?: string };
  if (!res.ok || !body.access_token) throw new Error(`Twitch token request failed: ${body.message ?? res.status}`);
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? "", expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

async function validateToken(accessToken: string): Promise<{ login: string; scopes: string[] }> {
  const res = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { authorization: `OAuth ${accessToken}` } });
  const body = (await res.json()) as { login?: string; scopes?: string[]; message?: string };
  if (!res.ok || !body.login) throw new Error(`Twitch token is not valid: ${body.message ?? res.status}`);
  return { login: body.login.toLowerCase(), scopes: body.scopes ?? [] };
}

function authorizeUrl(o: TwitchOptions, redirectUri: string, scope: string, state: string): string {
  const u = new URL("https://id.twitch.tv/oauth2/authorize");
  u.search = new URLSearchParams({ client_id: o.clientId, redirect_uri: redirectUri, response_type: "code", scope, state, force_verify: "true" }).toString();
  return u.toString();
}

/**
 * Streamers prove they own a Twitch channel by logging in with Twitch once. Beam keeps only the
 * pairing (channel → Beam wallet); the login token is used to read the username and dropped.
 * The bot joins a channel only when its owner linked it this way.
 */
export class TwitchLinks {
  private links: Record<string, string> = {};
  private readonly file: string;

  constructor(private readonly o: TwitchOptions) {
    this.file = join(o.dataDir, "twitch-links.json");
  }

  get redirectUri() {
    return `${this.o.publicUrl}/twitch/link/callback`;
  }

  authorizeUrl(state: string) {
    return authorizeUrl(this.o, this.redirectUri, "", state);
  }

  async load() {
    try {
      this.links = JSON.parse(await readFile(this.file, "utf8")) as Record<string, string>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** OAuth callback: whose channel is this? Then pair it with the wallet that asked. */
  async link(code: string, creator: string): Promise<string> {
    const t = await tokenRequest(this.o, { code, grant_type: "authorization_code", redirect_uri: this.redirectUri });
    const { login } = await validateToken(t.accessToken);
    this.links[login] = creator.toLowerCase();
    await mkdir(this.o.dataDir, { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.links));
    await rename(`${this.file}.tmp`, this.file);
    return login;
  }

  /** The Beam wallet that proved ownership of this Twitch channel, if any. */
  ownerOf(login: string): string | null {
    return this.links[login.toLowerCase()] ?? null;
  }

  /** The Twitch channel this wallet proved it owns, if any. */
  channelOf(creator: string): string | null {
    const c = creator.toLowerCase();
    return Object.entries(this.links).find(([, w]) => w === c)?.[0] ?? null;
  }
}

export class TwitchAuth {
  private tokens: Tokens | null = null;
  private readonly file: string;

  constructor(private readonly o: TwitchOptions) {
    this.file = join(o.dataDir, "twitch-bot.json");
  }

  /** The bot account's Twitch login, once connected. */
  get login(): string | null {
    return this.tokens?.login ?? null;
  }

  get redirectUri() {
    return `${this.o.publicUrl}/twitch/bot/callback`;
  }

  authorizeUrl(state: string): string {
    return authorizeUrl(this.o, this.redirectUri, SCOPES, state);
  }

  async load(): Promise<Tokens | null> {
    try {
      this.tokens = JSON.parse(await readFile(this.file, "utf8")) as Tokens;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return this.tokens;
  }

  private async save(t: Tokens) {
    this.tokens = t;
    await mkdir(this.o.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(t), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** OAuth callback: exchange the code for the bot account's tokens and keep them. */
  async connect(code: string): Promise<string> {
    const t = await tokenRequest(this.o, { code, grant_type: "authorization_code", redirect_uri: this.redirectUri });
    const v = await validateToken(t.accessToken);
    for (const s of SCOPES.split(" ")) if (!v.scopes.includes(s)) throw new Error(`Twitch did not grant ${s}`);
    await this.save({ ...t, login: v.login });
    return v.login;
  }

  /** A current access token, refreshed when it is near expiry or was rejected. */
  async token(force = false): Promise<Tokens> {
    if (!this.tokens) throw new Error("the Beam bot is not connected to Twitch yet");
    if (force || this.tokens.expiresAt - Date.now() < 10 * 60_000) {
      const t = await tokenRequest(this.o, { grant_type: "refresh_token", refresh_token: this.tokens.refreshToken });
      await this.save({ ...t, login: this.tokens.login });
    }
    return this.tokens;
  }
}

// ------------------------------------------------------------------ chat (Twitch IRC over WebSocket)

export type ChatMessage = { channel: string; user: string; displayName: string; text: string; isMod: boolean };

class TwitchChat extends EventEmitter<{ message: [ChatMessage]; status: [string]; authFailed: [] }> {
  private ws: WebSocket | null = null;
  private wanted = new Set<string>();
  private attempt = 0;

  constructor(private readonly auth: TwitchAuth) {
    super();
  }

  async connect(forceRefresh = false) {
    const t = await this.auth.token(forceRefresh);
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;
    ws.on("open", () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send(`PASS oauth:${t.accessToken}`);
      ws.send(`NICK ${t.login}`);
    });
    ws.on("message", (data) => {
      for (const line of String(data).split("\r\n")) if (line) this.onLine(line);
    });
    ws.on("close", () => {
      this.emit("status", "reconnecting");
      const delay = Math.min(1000 * 2 ** this.attempt++, 30_000);
      setTimeout(() => void this.connect().catch((e) => this.emit("status", `error: ${(e as Error).message}`)), delay);
    });
    ws.on("error", () => {});
  }

  private onLine(line: string) {
    if (line.startsWith("PING")) return this.ws?.send(line.replace("PING", "PONG"));
    if (/ 001 /.test(line)) {
      this.attempt = 0;
      this.emit("status", "connected");
      if (this.wanted.size) this.ws?.send(`JOIN ${[...this.wanted].map((c) => `#${c}`).join(",")}`);
      return;
    }
    if (/:tmi\.twitch\.tv NOTICE \* :Login authentication failed/.test(line)) {
      this.emit("authFailed");
      return;
    }
    if (line.includes("RECONNECT")) return this.ws?.close();
    const m = /^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #(\w+) :(.*)$/.exec(line);
    if (!m) return;
    const tags = Object.fromEntries((m[1] ?? "").split(";").map((kv) => kv.split("=") as [string, string]));
    this.emit("message", {
      user: m[2]!,
      channel: m[3]!,
      text: m[4]!,
      displayName: tags["display-name"] || m[2]!,
      isMod: tags.mod === "1" || (tags.badges ?? "").includes("broadcaster"),
    });
  }

  setChannels(channels: Set<string>) {
    const add = [...channels].filter((c) => !this.wanted.has(c));
    const drop = [...this.wanted].filter((c) => !channels.has(c));
    this.wanted = new Set(channels);
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (add.length) this.ws.send(`JOIN ${add.map((c) => `#${c}`).join(",")}`);
    if (drop.length) this.ws.send(`PART ${drop.map((c) => `#${c}`).join(",")}`);
  }

  say(channel: string, text: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(`PRIVMSG #${channel} :${text}`);
  }

  reconnectWithFreshToken() {
    this.ws?.removeAllListeners("close");
    this.ws?.close();
    void this.connect(true).catch((e) => this.emit("status", `error: ${(e as Error).message}`));
  }
}

// ------------------------------------------------------------------ the bot

/** Viewer-chosen text going into chat: one line, no control characters, bounded length. */
export function clean(s: string, max = 120): string {
  const one = s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Parses "!gift", "!gift @user", "!gift @user 5" (amount in USD, up to 2 decimals). */
export function parseGiftCommand(text: string): { to: string | null; amount: string | null } | null {
  const m = /^!gift(?:\s+@?([A-Za-z0-9_]{3,25}))?(?:\s+\$?(\d{1,4}(?:\.\d{1,2})?))?\s*$/i.exec(text.trim());
  if (!m) return null;
  return { to: m[1] ? `@${m[1]}` : null, amount: m[2] ?? null };
}

export class BeamBot {
  readonly auth: TwitchAuth;
  readonly links: TwitchLinks;
  private readonly chat: TwitchChat;
  /** twitch channel (lowercase) → creator settings */
  private channels = new Map<string, SignedConfig>();
  private readonly lastSent = new Map<string, number>();
  status = "not connected";

  constructor(
    private readonly o: TwitchOptions,
    private readonly creators: CreatorStore,
  ) {
    this.auth = new TwitchAuth(o);
    this.links = new TwitchLinks(o);
    this.chat = new TwitchChat(this.auth);
    this.chat.on("status", (s) => (this.status = s));
    this.chat.on("authFailed", () => this.chat.reconnectWithFreshToken());
    this.chat.on("message", (m) => this.onMessage(m));
    creators.on("saved", () => void this.refreshChannels());
  }

  async start() {
    await this.links.load();
    if (!(await this.auth.load())) {
      this.status = "waiting for /twitch/bot/connect";
      return;
    }
    await this.refreshChannels();
    await this.chat.connect();
  }

  /** Channels the bot is in, and whose wallet each belongs to. */
  joined(): [string, string][] {
    return [...this.channels].map(([c, sc]) => [c, sc.config.creator.toLowerCase()]);
  }

  async refreshChannels() {
    const next = new Map<string, SignedConfig>();
    for (const sc of await this.creators.all()) {
      const s = sc.config.stream;
      // Only channels whose owner proved it by logging in with Twitch, paired to this same wallet.
      const channel = s?.platform === "twitch" ? s.channel.toLowerCase() : null;
      if (sc.config.chatBot && channel && this.links.ownerOf(channel) === sc.config.creator.toLowerCase()) next.set(channel, sc);
    }
    this.channels = next;
    this.chat.setChannels(new Set(next.keys()));
  }

  /** Beam channel links for chat. */
  private giftUrl(creator: string, to?: string | null, amount?: string | null) {
    const u = new URL(`${this.o.publicUrl}/g/${creator}`);
    if (to) u.searchParams.set("to", to);
    if (amount) u.searchParams.set("amount", amount);
    return u.toString();
  }

  private say(channel: string, text: string) {
    // At most one message per channel per 1.5 s keeps clear of Twitch's chat limits.
    const now = Date.now();
    const wait = Math.max(0, (this.lastSent.get(channel) ?? 0) + 1500 - now);
    this.lastSent.set(channel, now + wait);
    setTimeout(() => this.chat.say(channel, clean(text, 480)), wait);
  }

  private onMessage(m: ChatMessage) {
    const sc = this.channels.get(m.channel.toLowerCase());
    if (!sc) return;
    const cmd = parseGiftCommand(m.text);
    if (!cmd) return;
    const name = clean(sc.config.displayName || m.channel, 40);
    if (!cmd.to) {
      this.say(m.channel, `@${m.user} 💜 Gift ${name} on stream (no app or crypto needed): ${this.giftUrl(sc.config.creator)}`);
    } else {
      this.say(
        m.channel,
        `@${m.user} 🎁 Gift ${cmd.to}${cmd.amount ? ` $${cmd.amount}` : ""} here; they claim it with a passkey: ${this.giftUrl(sc.config.creator, cmd.to, cmd.amount)}`,
      );
    }
  }

  private channelFor(creator: string): string | null {
    for (const [channel, sc] of this.channels) if (sc.config.creator.toLowerCase() === creator.toLowerCase()) return channel;
    return null;
  }

  /** Announce a live gift in the creator's chat. */
  announceGift(g: Gift) {
    const channel = this.channelFor(g.channel);
    if (!channel) return;
    const who = clean(g.displayName || "Someone", 32);
    const amt = usdLabel(BigInt(g.amount));
    const msg = g.message ? `: "${clean(g.message, 140)}"` : "";
    if (g.kind === "Chatter") {
      const label = clean(g.recipientLabel ?? "a chatter", 32);
      this.say(channel, `🎁 ${who} sent ${label} ${amt}${msg} ${label}, the claim link is coming your way.`);
    } else if (g.kind === "Bomb") {
      this.say(channel, `💣 ${who} dropped a ${amt} Beam Bomb for ${g.slots} chatters${msg} Grab a share when the link lands!`);
    } else {
      this.say(channel, `🎉 ${who} gifted ${amt}${msg}`);
    }
  }

  /** Announce that a chatter claimed their gift (proof they really got paid). */
  announceClaim(c: ClaimEvent & { kind: string; from: string; recipientLabel: string | null }, channelCreator: string) {
    const channel = this.channelFor(channelCreator);
    if (!channel) return;
    const who = c.kind === "Chatter" && c.recipientLabel ? clean(c.recipientLabel, 32) : `${c.recipient.slice(0, 6)}…${c.recipient.slice(-4)}`;
    this.say(channel, `✅ ${who} claimed ${usdLabel(BigInt(c.amount))} (${formatUsdc(BigInt(c.amount))} USDC) with no wallet beforehand.`);
  }
}

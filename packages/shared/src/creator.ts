import { type Address, type Hex, type LocalAccount, getAddress, verifyTypedData } from "viem";
import type { Deployment } from "./deployments.js";
import { MAX_NAME_BYTES, parseUsdc } from "./gift.js";
import { BPS, MAX_SPLIT_RECIPIENTS, type Split, checkSplit } from "./split.js";

/** A share of every gift, paid in the same transaction (co-streamer, mod, editor, charity). */
export type SplitShare = { address: Address; bps: number; label: string };

/**
 * Where the creator goes live, so their watch page can embed it. `channel` is the Twitch or Kick
 * channel name, or for YouTube a channel id (UC…) or a live video id.
 */
export type StreamLink = { platform: "twitch" | "youtube" | "kick"; channel: string };

/** A creator's public settings. The creator signs them; the server only stores and serves them. */
export type CreatorConfig = {
  creator: Address;
  displayName: string;
  goal: { usdc: string; title: string; since: number } | null;
  shares: SplitShare[];
  /** Optional; settings saved before it existed have no `stream` key and still verify. */
  stream?: StreamLink | null;
  /** Beam's chat bot joins the creator's Twitch chat: answers !gift and announces gifts. */
  chatBot?: boolean;
  /** Unix milliseconds; each saved version must be newer than the last. */
  updatedAt: number;
};

const CHANNEL_PATTERNS: Record<StreamLink["platform"], RegExp> = {
  twitch: /^[A-Za-z0-9_]{3,25}$/,
  kick: /^[A-Za-z0-9_-]{2,25}$/,
  // A channel id (UC + 22) or an 11-character video id.
  youtube: /^(UC[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{11})$/,
};

/**
 * Turns what a creator pastes (a URL or a bare name/id) into a StreamLink, or null if it isn't one.
 * Accepts twitch.tv/<name>, kick.com/<name>, youtube.com/channel/UC…, youtube.com/watch?v=…,
 * youtu.be/…, youtube.com/live/….
 */
export function parseStreamLink(platform: StreamLink["platform"], input: string): StreamLink | null {
  let v = input.trim();
  try {
    const u = new URL(v.startsWith("http") ? v : `https://${v}`);
    const host = u.hostname.replace(/^(www|m)\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    if (platform === "twitch" && host === "twitch.tv" && parts[0]) v = parts[0];
    if (platform === "kick" && host === "kick.com" && parts[0]) v = parts[0];
    if (platform === "youtube") {
      if (host === "youtu.be" && parts[0]) v = parts[0];
      else if (host === "youtube.com") {
        if (u.searchParams.get("v")) v = u.searchParams.get("v")!;
        else if ((parts[0] === "channel" || parts[0] === "live") && parts[1]) v = parts[1];
      }
    }
  } catch {
    // a bare name or id
  }
  v = v.replace(/^@/, "");
  return CHANNEL_PATTERNS[platform].test(v) ? { platform, channel: v } : null;
}

export const MAX_SHARES = MAX_SPLIT_RECIPIENTS - 1;
const MAX_LABEL = 24;

export function checkCreatorConfig(c: CreatorConfig): void {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(c.displayName) > MAX_NAME_BYTES) throw new Error("display name too long");
  if (c.goal) {
    if (parseUsdc(c.goal.usdc) <= 0n) throw new Error("goal must be positive");
    if (bytes(c.goal.title) > 40) throw new Error("goal title too long");
    if (!Number.isInteger(c.goal.since) || c.goal.since <= 0) throw new Error("goal start invalid");
  }
  if (c.shares.length > MAX_SHARES) throw new Error(`at most ${MAX_SHARES} shares`);
  for (const s of c.shares) if (bytes(s.label) > MAX_LABEL) throw new Error("share label too long");
  if (c.shares.length) checkSplit(splitOf(c)!);
  if (c.stream && !CHANNEL_PATTERNS[c.stream.platform]?.test(c.stream.channel)) throw new Error("stream channel invalid");
  if (!Number.isInteger(c.updatedAt) || c.updatedAt <= 0) throw new Error("updatedAt invalid");
}

/** The on-chain split for this creator, or null when every gift goes to them alone. */
export function splitOf(c: CreatorConfig): Split | null {
  if (!c.shares.length) return null;
  const others = c.shares.reduce((a, s) => a + s.bps, 0);
  if (others >= BPS) throw new Error("the creator must keep a share");
  return { recipients: [c.creator, ...c.shares.map((s) => s.address)], bps: [BPS - others, ...c.shares.map((s) => s.bps)] };
}

/** Canonical JSON: key order fixed, so the signed bytes are the stored bytes. */
export function canonicalConfig(c: CreatorConfig): string {
  return JSON.stringify({
    creator: getAddress(c.creator),
    displayName: c.displayName,
    goal: c.goal ? { usdc: c.goal.usdc, title: c.goal.title, since: c.goal.since } : null,
    shares: c.shares.map((s) => ({ address: getAddress(s.address), bps: s.bps, label: s.label })),
    // Present only when set, so settings signed before streams existed keep their exact bytes.
    ...(c.stream ? { stream: { platform: c.stream.platform, channel: c.stream.channel } } : {}),
    ...(c.chatBot ? { chatBot: true } : {}),
    updatedAt: c.updatedAt,
  });
}

const configTypes = { BeamCreatorConfig: [{ name: "config", type: "string" }] } as const;
const configDomain = (d: Deployment) => ({ name: "Beam", version: "1", chainId: d.chain.id }) as const;

export async function signCreatorConfig(d: Deployment, account: LocalAccount, c: CreatorConfig): Promise<Hex> {
  if (getAddress(c.creator) !== getAddress(account.address)) throw new Error("only the creator can sign their settings");
  checkCreatorConfig(c);
  return account.signTypedData({ domain: configDomain(d), types: configTypes, primaryType: "BeamCreatorConfig", message: { config: canonicalConfig(c) } });
}

export async function verifyCreatorConfig(d: Deployment, c: CreatorConfig, signature: Hex): Promise<boolean> {
  return verifyTypedData({
    address: c.creator,
    domain: configDomain(d),
    types: configTypes,
    primaryType: "BeamCreatorConfig",
    message: { config: canonicalConfig(c) },
    signature,
  });
}

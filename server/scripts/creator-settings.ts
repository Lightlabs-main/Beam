// Signs and saves a test creator's settings through the public API (testnet wallets from ../../.env).
// An existing goal with the same amount keeps counting from when it started.
//
//   NAME="Beam Test Stream" GOAL=25 GOAL_TITLE="Recording goal" STREAM=twitch:channel \
//     BEAM_URL=https://beamstreams.xyz pnpm --filter @beam/server exec tsx scripts/creator-settings.ts
//   STREAM is platform:channel (twitch:name, kick:name, youtube:<channel id or live link>); omit for none.
import { readFileSync } from "node:fs";
import { type CreatorConfig, type StreamLink, deployment, parseStreamLink, signCreatorConfig } from "@beam/shared";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = process.env.BEAM_URL ?? "https://beamstreams.xyz";
const cfg = (await (await fetch(`${base}/api/config`)).json()) as { network: "testnet" | "mainnet" };
const d = deployment(cfg.network);
const creator = privateKeyToAccount(env[`${process.env.SIGNER ?? "CREATOR"}_PRIVATE_KEY`] as Hex);
const current = ((await (await fetch(`${base}/api/creators/${creator.address}/config`)).json()) as { config: CreatorConfig | null }).config;

let stream: StreamLink | null = null;
if (process.env.STREAM) {
  const [platform, ...rest] = process.env.STREAM.split(":");
  stream = parseStreamLink(platform as StreamLink["platform"], rest.join(":"));
  if (!stream) throw new Error(`not a stream: ${process.env.STREAM}`);
}

const goal = process.env.GOAL
  ? {
      usdc: process.env.GOAL,
      title: process.env.GOAL_TITLE ?? "Stream goal",
      since: current?.goal?.usdc === process.env.GOAL ? current.goal.since : Math.floor(Date.now() / 1000),
    }
  : null;

const config: CreatorConfig = {
  creator: creator.address,
  displayName: process.env.NAME ?? current?.displayName ?? "Beam Test Stream",
  goal,
  shares: [],
  stream,
  updatedAt: Date.now(),
};
const res = await fetch(`${base}/api/creators/${creator.address}/config`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ config, signature: await signCreatorConfig(d, creator, config) }),
});
console.log(res.status, JSON.stringify(await res.json()).slice(0, 300));

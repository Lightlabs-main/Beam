// Signs and saves a test creator's settings through the public API (testnet wallets from ../../.env).
//
//   NAME="Beam Test Stream" GOAL=25 GOAL_TITLE="Recording goal" \
//     BEAM_URL=https://beamstreams.xyz pnpm --filter @beam/server exec tsx scripts/creator-settings.ts
import { readFileSync } from "node:fs";
import { type CreatorConfig, deployment, signCreatorConfig } from "@beam/shared";
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

const config: CreatorConfig = {
  creator: creator.address,
  displayName: process.env.NAME ?? "Beam Test Stream",
  goal: process.env.GOAL
    ? { usdc: process.env.GOAL, title: process.env.GOAL_TITLE ?? "Stream goal", since: Math.floor(Date.now() / 1000) }
    : null,
  shares: [],
  updatedAt: Date.now(),
};
const res = await fetch(`${base}/api/creators/${creator.address}/config`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ config, signature: await signCreatorConfig(d, creator, config) }),
});
console.log(res.status, JSON.stringify(await res.json()).slice(0, 300));

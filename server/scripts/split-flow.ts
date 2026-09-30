// Instant splits through Beam's public API: the creator signs settings with two shares, a viewer
// gifts $1, and every share is paid in the same transaction. Then the settings are reset to no
// shares. Wallets: CREATOR_PRIVATE_KEY and VIEWER_PRIVATE_KEY from ../../.env (testnet).
//
//   BEAM_URL=https://beamstreams.xyz pnpm --filter @beam/server exec tsx scripts/split-flow.ts
import { readFileSync } from "node:fs";
import { type CreatorConfig, deployment, parseUsdc, signCreatorConfig, signSplitGift, splitOf, usdLabel } from "@beam/shared";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = process.env.BEAM_URL ?? "https://beamstreams.xyz";
const cfg = (await (await fetch(`${base}/api/config`)).json()) as { network: "testnet" | "mainnet"; beamGifts: string };
const d = deployment(cfg.network);
const creator = privateKeyToAccount(env.CREATOR_PRIVATE_KEY as Hex);
const viewer = privateKeyToAccount(env.VIEWER_PRIVATE_KEY as Hex);
const mod = privateKeyToAccount(generatePrivateKey()).address;
const charity = privateKeyToAccount(generatePrivateKey()).address;

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const usdc = async (a: string) => BigInt(((await (await fetch(`${base}/api/accounts/${a}`)).json()) as { usdc: string }).usdc);

async function saveSettings(shares: CreatorConfig["shares"]) {
  const config: CreatorConfig = { creator: creator.address, displayName: "Beam Test Stream", goal: null, shares, updatedAt: Date.now() };
  const r = await req("PUT", `/api/creators/${creator.address}/config`, { config, signature: await signCreatorConfig(d, creator, config) });
  if (r.status !== 200) throw new Error(`save failed ${r.status}: ${r.body.error}`);
  return config;
}

// 1. Creator signs settings with two shares.
const config = await saveSettings([
  { address: mod, bps: 1000, label: "Mod" },
  { address: charity, bps: 500, label: "Charity" },
]);
const split = splitOf(config)!;
console.log(`settings saved: ${split.bps.map((b) => `${b / 100}%`).join(" / ")}`);

// 2. Someone else's signature over the same settings is refused.
const forged = await req("PUT", `/api/creators/${creator.address}/config`, {
  config: { ...config, updatedAt: Date.now() + 1 },
  signature: await signCreatorConfig(d, viewer, { ...config, creator: viewer.address }),
});
console.log(`forged settings: ${forged.status} ${forged.body.error}`);

// 3. A viewer gifts $1 to the creator; every share lands in the same transaction.
const before = await Promise.all([creator.address, mod, charity, cfg.beamGifts].map(usdc));
const auth = await signSplitGift(d, viewer, {
  split,
  meta: { displayName: "JUDGE", message: "for the whole crew", actionCode: 1 },
  value: parseUsdc("1"),
  validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
  salt: generatePrivateKey(),
});
const t0 = Date.now();
const sent = await req("POST", "/api/relay/split", { split, meta: { displayName: "JUDGE", message: "for the whole crew", actionCode: 1 }, auth });
if (sent.status !== 200) throw new Error(`split failed ${sent.status}: ${sent.body.error}`);
console.log(`split gift settled in ${Date.now() - t0}ms: ${sent.body.hash}`);
const after = await Promise.all([creator.address, mod, charity, cfg.beamGifts].map(usdc));
for (const [i, who] of ["creator", "mod", "charity", "BeamGifts contract"].entries()) {
  console.log(`  ${who}: +${usdLabel(after[i]! - before[i]!)} (${after[i]! - before[i]!} units)`);
}

// 4. Reset: gifts to this test creator go entirely to them again.
await saveSettings([]);
console.log("settings reset to no shares");

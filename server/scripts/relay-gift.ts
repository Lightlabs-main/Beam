// Sends one real gift through Beam's relayer API, exactly as the gift page will: the viewer signs
// off-chain and POSTs the authorization; the relayer pays gas. Prints timings for each stage.
//
//   BEAM_URL=http://localhost:8787 AMOUNT=1 MESSAGE="hi" pnpm --filter @beam/server exec tsx scripts/relay-gift.ts
//
// Reads VIEWER_PRIVATE_KEY and CREATOR_ADDRESS from the repository .env (testnet test wallets).
import { readFileSync } from "node:fs";
import { deployment, parseNetwork, parseUsdc, signGift } from "@beam/shared";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const base = process.env.BEAM_URL ?? "http://localhost:8787";
const d = deployment(parseNetwork(process.env.BEAM_NETWORK ?? "testnet"));
// SIGNER picks which test wallet signs (default VIEWER): e.g. SIGNER=CREATOR.
const viewer = privateKeyToAccount(env[`${process.env.SIGNER ?? "VIEWER"}_PRIVATE_KEY`] as Hex);
const to = (process.env.TO ?? env.CREATOR_ADDRESS) as Address;
const meta = {
  displayName: process.env.NAME ?? "JUDGE",
  message: process.env.MESSAGE ?? "",
  actionCode: Number(process.env.ACTION ?? 1),
};

const t0 = Date.now();
const auth = await signGift(d, viewer, {
  to,
  meta,
  value: parseUsdc(process.env.AMOUNT ?? "1"),
  validBefore: BigInt(Math.floor(t0 / 1000) + 600),
  salt: generatePrivateKey(),
});
const t1 = Date.now();
const payload = JSON.stringify({ to, meta, auth }, (_, v) => (typeof v === "bigint" ? v.toString() : v));

// SIGN_ONLY=1 prints the signed request instead of sending it (for latency-probe.ts).
if (process.env.SIGN_ONLY === "1") {
  console.log(payload);
  process.exit(0);
}

const res = await fetch(`${base}/api/relay/gift`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: payload,
});
const t2 = Date.now();
const body = await res.json();

console.log(JSON.stringify({ http: res.status, ...body }, null, 2));
console.log(`signed in ${t1 - t0}ms · relayed and included in ${t2 - t1}ms · submitted at ${t1}, receipt at ${t2}`);
if (!res.ok) process.exit(1);

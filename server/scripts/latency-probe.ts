// Measures one real gift end to end on a single clock: relay request → on-chain receipt →
// the indexed gift arriving on an overlay's WebSocket. Reads a signed gift body (from
// relay-gift.ts with SIGN_ONLY=1) on stdin, so no private key needs to be where this runs.
//
//   docker compose exec -T server pnpm exec tsx scripts/latency-probe.ts < body.json
import WebSocket from "ws";

const base = process.env.BEAM_URL ?? "http://localhost:8787";
const body = await new Promise<string>((resolve) => {
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s));
});
const { to } = JSON.parse(body) as { to: string };

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?creator=${to}`);
await new Promise((r) => ws.once("open", r));

let hash = "";
const arrived = new Promise<number>((resolve) => {
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as { type: string; gift?: { txHash: string } };
    if (msg.type === "gift" && msg.gift && (!hash || msg.gift.txHash === hash)) resolve(Date.now());
  });
});

const tPost = Date.now();
const res = await fetch(`${base}/api/relay/gift`, { method: "POST", headers: { "content-type": "application/json" }, body });
const tReceipt = Date.now();
const result = (await res.json()) as { hash?: string; blockNumber?: string; error?: string };
if (!res.ok || !result.hash) {
  console.error(res.status, result);
  process.exit(1);
}
hash = result.hash;
const tOverlay = await Promise.race([arrived, new Promise<number>((_, rej) => setTimeout(() => rej(new Error("no WebSocket gift within 30s")), 30_000))]);
ws.close();

console.log(
  JSON.stringify({
    tx: hash,
    block: result.blockNumber,
    relayToReceiptMs: tReceipt - tPost,
    receiptToOverlayMs: tOverlay - tReceipt,
    relayToOverlayMs: tOverlay - tPost,
  }),
);

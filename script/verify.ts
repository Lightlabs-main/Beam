// pnpm verify: asserts every dependency Beam is built on against live Monad and the live service.
// Exits non-zero if any check fails. Runs in CI and before every deploy.
//
//   pnpm verify                         # testnet + https://testnet.beamstreams.xyz
//   BEAM_NETWORK=mainnet BEAM_URL=... pnpm verify
import {
  DropKind,
  beamClaimsAbi,
  beamGiftsAbi,
  deployment,
  dropNonce,
  giftNonce,
  makeClaimKeys,
  parseNetwork,
  usdcDomain,
} from "@beam/shared";
import { type Address, createPublicClient, domainSeparator, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const d = deployment(parseNetwork(process.env.BEAM_NETWORK ?? "testnet"));
const base = process.env.BEAM_URL ?? (d.network === "testnet" ? "https://testnet.beamstreams.xyz" : "https://beamstreams.xyz");
const client = createPublicClient({ chain: d.chain, transport: http(process.env.RPC_URL) });
const HYPERSYNC: Record<string, string> = { testnet: "https://10143.hypersync.xyz", mainnet: "https://143.hypersync.xyz" };

const usdcAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

let failures = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    console.log(`✓ ${name}${detail ? `  (${detail})` : ""}`);
  } catch (e) {
    failures++;
    console.log(`✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
  assert(res.ok, `${path} answered ${res.status}`);
  return (await res.json()) as T;
}

console.log(`Beam verify · ${d.network} (chain ${d.chain.id}) · ${base}\n`);

// ---- chain
await check("RPC serves the expected chain", async () => {
  const id = await client.getChainId();
  assert(id === d.chain.id, `chain id ${id}, expected ${d.chain.id}`);
  return `block ${await client.getBlockNumber()}`;
});

// ---- USDC + gasless path
await check("USDC is Circle FiatToken v2 with 6 decimals", async () => {
  const [name, version, decimals] = await Promise.all([
    client.readContract({ address: d.usdc, abi: usdcAbi, functionName: "name" }),
    client.readContract({ address: d.usdc, abi: usdcAbi, functionName: "version" }),
    client.readContract({ address: d.usdc, abi: usdcAbi, functionName: "decimals" }),
  ]);
  assert(name === "USDC" && version === "2" && decimals === 6, `got ${name} v${version}, ${decimals} decimals`);
  return d.usdc;
});
await check("USDC EIP-712 domain matches what Beam signs", async () => {
  const onChain = await client.readContract({ address: d.usdc, abi: usdcAbi, functionName: "DOMAIN_SEPARATOR" });
  assert(domainSeparator({ domain: usdcDomain(d) }) === onChain, "domain separator mismatch");
});
await check("USDC supports EIP-3009 authorizations", async () => {
  const used = await client.readContract({
    address: d.usdc,
    abi: usdcAbi,
    functionName: "authorizationState",
    args: [privateKeyToAccount(generatePrivateKey()).address, generatePrivateKey()],
  });
  assert(used === false, "fresh authorization reported as used");
});

// ---- Beam contracts
for (const [name, address, abi] of [
  ["BeamGifts", d.beamGifts, beamGiftsAbi],
  ["BeamClaims", d.beamClaims, beamClaimsAbi],
] as const) {
  await check(`${name} is deployed against this USDC`, async () => {
    const code = await client.getCode({ address });
    assert(code && code.length > 2, `no code at ${address}`);
    const usdc = await client.readContract({ address, abi, functionName: "usdc" });
    assert((usdc as Address).toLowerCase() === d.usdc.toLowerCase(), `usdc() is ${usdc}`);
    return address;
  });
}
await check("Gift nonces signed in the browser match BeamGifts", async () => {
  const from = privateKeyToAccount(generatePrivateKey()).address;
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const meta = { displayName: "verify", message: "✓", actionCode: 1 };
  const salt = generatePrivateKey();
  const onChain = await client.readContract({ address: d.beamGifts, abi: beamGiftsAbi, functionName: "giftNonce", args: [from, to, meta, salt] });
  assert(onChain === giftNonce(d, from, to, meta, salt), "giftNonce mismatch");
});
await check("Drop ids signed in the browser match BeamClaims", async () => {
  const from = privateKeyToAccount(generatePrivateKey()).address;
  const p = {
    channel: privateKeyToAccount(generatePrivateKey()).address,
    slots: 3,
    slotRoot: makeClaimKeys(3).root,
    expiry: 2_000_000_000n,
    recipientLabel: "",
  };
  const meta = { displayName: "verify", message: "", actionCode: 9 };
  const salt = generatePrivateKey();
  const onChain = await client.readContract({
    address: d.beamClaims,
    abi: beamClaimsAbi,
    functionName: "dropNonce",
    args: [from, DropKind.Bomb, p, meta, salt],
  });
  assert(onChain === dropNonce(d, from, DropKind.Bomb, p, meta, salt), "dropNonce mismatch");
});

// ---- indexing
await check("Envio HyperSync keeps up with the chain head", async () => {
  const [head, hs] = await Promise.all([
    client.getBlockNumber(),
    fetch(`${HYPERSYNC[d.network]}/height`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<{ height: number }>),
  ]);
  const lag = Number(head) - hs.height;
  assert(lag < 50, `HyperSync ${lag} blocks behind`);
  return lag <= 0 ? "at the chain head" : `${lag} blocks behind head`;
});

// ---- live service
await check("Service runs this deployment", async () => {
  const cfg = await getJson<{ network: string; chainId: number; usdc: string; beamGifts: string; beamClaims: string }>("/api/config");
  assert(cfg.network === d.network && cfg.chainId === d.chain.id, `service is on ${cfg.network}/${cfg.chainId}`);
  assert(cfg.usdc.toLowerCase() === d.usdc.toLowerCase(), `service USDC ${cfg.usdc}`);
  assert(cfg.beamGifts.toLowerCase() === d.beamGifts.toLowerCase(), `service BeamGifts ${cfg.beamGifts}`);
  assert(cfg.beamClaims.toLowerCase() === d.beamClaims.toLowerCase(), `service BeamClaims ${cfg.beamClaims}`);
});
await check("Relayer can sponsor gas; live feeds are connected", async () => {
  const h = await getJson<{ relayer: string; relayerBalanceWei: string; relayerAboveFloor: boolean; indexer: string; chainPush: string }>(
    "/healthz",
  );
  assert(h.relayerAboveFloor, `relayer ${h.relayer} is below its gas floor (${h.relayerBalanceWei} wei)`);
  assert(h.indexer === "connected", `indexer feed is ${h.indexer}`);
  assert(["subscribed", "connected"].includes(h.chainPush), `chain push is ${h.chainPush}`);
  return `relayer ${(Number(BigInt(h.relayerBalanceWei) / 10n ** 15n) / 1000).toFixed(3)} MON`;
});
for (const [label, path] of [
  ["Landing page", "/"],
  ["Overlay", "/overlay"],
  ["Gift page", `/g/${d.beamGifts}`],
  ["Wallet page", "/wallet"],
] as const) {
  await check(`${label} is served over HTTPS`, async () => {
    const res = await fetch(`${base}${path}`, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
    assert(res.ok && (res.headers.get("content-type") ?? "").includes("text/html"), `${path} answered ${res.status}`);
  });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

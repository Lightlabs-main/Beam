import { type Deployment, deployment, parseNetwork, parseUsdc } from "@beam/shared";
import { type Hex, parseEther } from "viem";

export type Config = {
  d: Deployment;
  rpcUrl: string;
  port: number;
  relayerKey: Hex;
  /** Refuse to sponsor gas below this relayer balance (wei); the balance is an operational dependency. */
  relayerFloorWei: bigint;
  /** Smallest gift the relayer will sponsor (USDC base units). */
  minGiftUnits: bigint;
  /** Relay requests allowed per client IP per minute. */
  relayPerMinute: number;
  hasuraHttpUrl: string;
  hasuraWsUrl: string;
  hasuraAdminSecret: string;
  webDir: string;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const optional = (name: string, fallback: string) => process.env[name] || fallback;

export function loadConfig(): Config {
  const d = deployment(parseNetwork(process.env.BEAM_NETWORK));
  const relayerKey = required("RELAYER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hex key");
  const hasuraHttpUrl = optional("HASURA_URL", "http://localhost:8080/v1/graphql");
  return {
    d,
    rpcUrl: optional("RPC_URL", d.chain.rpcUrls.default.http[0]!),
    port: Number(optional("PORT", "8787")),
    relayerKey: relayerKey as Hex,
    relayerFloorWei: parseEther(optional("RELAYER_MIN_BALANCE_MON", "0.5")),
    minGiftUnits: parseUsdc(optional("MIN_GIFT_USDC", "0.1")),
    relayPerMinute: Number(optional("RELAY_PER_MINUTE", "20")),
    hasuraHttpUrl,
    hasuraWsUrl: optional("HASURA_WS_URL", hasuraHttpUrl.replace(/^http/, "ws")),
    hasuraAdminSecret: required("HASURA_ADMIN_SECRET"),
    webDir: optional("WEB_DIR", new URL("../../web/dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  };
}

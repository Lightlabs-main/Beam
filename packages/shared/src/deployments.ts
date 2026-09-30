import { type Address, type Chain } from "viem";
import { monad, monadTestnet } from "viem/chains";
import testnet from "../../../contracts/deployments/testnet.json" with { type: "json" };

export type Network = "testnet" | "mainnet";

export type Deployment = {
  network: Network;
  chain: Chain;
  usdc: Address;
  beamGifts: Address;
  beamClaims: Address;
  startBlock: bigint;
  explorer: string;
};

// Only networks with a recorded deployment in contracts/deployments/ are available.
const records: Partial<Record<Network, typeof testnet>> = { testnet };
const chains: Record<Network, Chain> = { testnet: monadTestnet, mainnet: monad };

export function deployment(network: Network): Deployment {
  const r = records[network];
  if (!r) throw new Error(`no deployment recorded for ${network} in contracts/deployments/`);
  if (r.chainId !== chains[network].id) throw new Error(`${network} deployment chainId ${r.chainId} mismatch`);
  return {
    network,
    chain: chains[network],
    usdc: r.usdc as Address,
    beamGifts: r.BeamGifts.address as Address,
    beamClaims: r.BeamClaims.address as Address,
    startBlock: BigInt(Math.min(r.BeamGifts.block, r.BeamClaims.block)),
    explorer: r.explorer,
  };
}

export function parseNetwork(value: string | undefined): Network {
  if (value === "testnet" || value === "mainnet") return value;
  throw new Error(`BEAM_NETWORK must be "testnet" or "mainnet", got ${JSON.stringify(value)}`);
}

export const txUrl = (d: Deployment, hash: string) => `${d.explorer}/tx/${hash}`;
export const addressUrl = (d: Deployment, address: string) => `${d.explorer}/address/${address}`;

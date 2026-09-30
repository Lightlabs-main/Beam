// Shared plumbing for the viewer pages: server config, balances, and the passkey sign-in card.
import { type Deployment, deployment } from "@beam/shared";
import { type Wallet, createWallet, hasPasskeyOnDevice, passkeyErrorMessage, rememberedAddress, signIn } from "./wallet.js";

export type ServerConfig = {
  network: "testnet" | "mainnet";
  chainId: number;
  usdc: string;
  beamGifts: string;
  explorer: string;
  minGiftUsdc: string;
};

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function loadConfig(): Promise<{ cfg: ServerConfig; d: Deployment }> {
  const cfg = (await (await fetch("/api/config")).json()) as ServerConfig;
  const d = deployment(cfg.network);
  if (d.beamGifts.toLowerCase() !== cfg.beamGifts.toLowerCase()) {
    throw new Error("This page is out of date with the server. Reload to continue.");
  }
  const net = document.getElementById("net");
  if (net) {
    net.textContent = cfg.network === "mainnet" ? "Monad" : "Monad testnet";
    net.hidden = false;
  }
  return { cfg, d };
}

export async function balances(address: string): Promise<{ usdc: bigint; mon: bigint }> {
  const res = await fetch(`/api/accounts/${address}`);
  if (!res.ok) throw new Error(`balance lookup failed (${res.status})`);
  const b = (await res.json()) as { usdc: string; mon: string };
  return { usdc: BigInt(b.usdc), mon: BigInt(b.mon) };
}

export async function copyText(text: string, button: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  const was = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = was), 1500);
}

/**
 * Wires the sign-in card (markup ids: signin, signin-primary, signin-other, signin-error,
 * optional name input) and resolves once the viewer has a wallet.
 */
export function signInCard(nameInput?: HTMLInputElement): Promise<Wallet> {
  const primary = $<HTMLButtonElement>("signin-primary");
  const other = $<HTMLButtonElement>("signin-other");
  const error = $("signin-error");
  const known = hasPasskeyOnDevice();
  const remembered = rememberedAddress();
  primary.textContent = known && remembered ? `Continue as ${short(remembered)}` : "Create my wallet with a passkey";
  if (nameInput) nameInput.closest(".field")!.toggleAttribute("hidden", known);

  return new Promise((resolve) => {
    const attempt = async (fn: () => Promise<Wallet>, button: HTMLButtonElement) => {
      error.hidden = true;
      primary.disabled = other.disabled = true;
      const label = button.textContent;
      button.innerHTML = `<span class="spinner"></span>Waiting for your passkey…`;
      try {
        const wallet = await fn();
        $("signin").hidden = true;
        resolve(wallet);
      } catch (e) {
        error.textContent = passkeyErrorMessage(e);
        error.hidden = false;
      } finally {
        button.textContent = label;
        primary.disabled = other.disabled = false;
      }
    };
    primary.onclick = () => attempt(() => (known ? signIn() : createWallet(nameInput?.value ?? "")), primary);
    other.onclick = () => attempt(() => signIn(true), other);
  });
}

/** A chatter gift or bomb this device sent; kept so the sender never loses the claim link. */
export type SentDrop = { dropId: string; link: string; label: string; amount: string; channel: string; createdAt: number };
const SENT_KEY = "beam.sentDrops";

export function sentDrops(): SentDrop[] {
  try {
    return JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]") as SentDrop[];
  } catch {
    return [];
  }
}

export function saveSentDrop(drop: SentDrop) {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify([drop, ...sentDrops().filter((x) => x.dropId !== drop.dropId)].slice(0, 50)));
  } catch {}
}

export function randomSalt(): `0x${string}` {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// Quick setup (/setup): builds a creator's OBS overlay URL locally from their wallet address.
import { parseUsdc } from "@beam/shared";
import { downloadObsSetup } from "./obs.js";
import { mountObsConnect } from "./obsconnect.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

async function showNetwork() {
  try {
    const cfg = (await (await fetch("/api/config")).json()) as { network: "testnet" | "mainnet" };
    const net = $("net");
    net.textContent = cfg.network === "mainnet" ? "Monad" : "Monad testnet";
    net.hidden = false;
  } catch {
    /* offline from the API: the builder still works */
  }
}

$<HTMLFormElement>("setup").addEventListener("submit", (e) => {
  e.preventDefault();
  const address = $<HTMLInputElement>("address").value.trim();
  const goalRaw = $<HTMLInputElement>("goal").value.trim();
  const title = $<HTMLInputElement>("title").value.trim();

  const addressOk = isAddress(address);
  $("address-error").hidden = addressOk;

  let goalOk = true;
  if (goalRaw) {
    try {
      goalOk = parseUsdc(goalRaw) > 0n;
    } catch {
      goalOk = false;
    }
  }
  $("goal-error").hidden = goalOk;
  if (!addressOk || !goalOk) return;

  const params = new URLSearchParams({ creator: address });
  if (goalRaw) {
    params.set("goal", goalRaw);
    // The goal counts gifts from now on.
    params.set("since", String(Math.floor(Date.now() / 1000)));
    params.set("title", title || "Stream goal");
  }
  const url = `${location.origin}/overlay?${params}`;
  $<HTMLInputElement>("url").value = url;
  $<HTMLAnchorElement>("preview").href = url;
  $("obs-download").onclick = () => downloadObsSetup(url);
  mountObsConnect($("obs-connect"), url);
  $("goal-note").hidden = !goalRaw;
  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("copy").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("url");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand("copy");
  }
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

void showNetwork();

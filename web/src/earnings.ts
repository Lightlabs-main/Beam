// Earnings (/earnings?creator=0x…): what a creator received, straight from the chain and the index.
// Read-only and public, like the chain itself.
import { usdLabel } from "@beam/shared";
import { $, loadConfig, short } from "./pagekit.js";

type Earnings = {
  total: string;
  gifts: number;
  balance: string;
  explorer: string;
  recent: {
    kind: "Direct" | "Split";
    from: string;
    displayName: string;
    message: string;
    amount: string;
    received: string | null;
    ts: string;
    txHash: string;
  }[];
};

const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

async function main() {
  const creator = new URLSearchParams(location.search).get("creator") ?? "";
  const { d } = await loadConfig();
  if (!isAddress(creator)) {
    $("setup").hidden = false;
    $("go").onclick = () => {
      const a = $<HTMLInputElement>("creator").value.trim();
      if (isAddress(a)) location.search = `?creator=${a}`;
    };
    return;
  }

  const settings = await fetch(`/api/creators/${creator}/config`)
    .then((r) => r.json() as Promise<{ config: { displayName: string } | null }>)
    .catch(() => ({ config: null }));
  $("who").textContent = settings.config?.displayName ? `${settings.config.displayName} · ${short(creator)}` : short(creator);
  $("view").hidden = false;

  const render = async () => {
    const res = await fetch(`/api/creators/${creator}/earnings`);
    if (!res.ok) throw new Error(`earnings unavailable (${res.status})`);
    const e = (await res.json()) as Earnings;
    $("balance").textContent = usdLabel(BigInt(e.balance));
    $("total").textContent = usdLabel(BigInt(e.total));
    $("count").textContent = `${e.gifts} gift${e.gifts === 1 ? "" : "s"}`;
    $<HTMLAnchorElement>("explorer").href = e.explorer;
    $("empty").hidden = e.recent.length > 0;
    $("gifts").replaceChildren(
      ...e.recent.map((g) => {
        const li = document.createElement("li");
        li.className = "chip";
        li.style.marginTop = "8px";
        const left = document.createElement("div");
        left.style.minWidth = "0";
        const name = document.createElement("div");
        name.style.fontWeight = "700";
        name.textContent = g.displayName.trim() || short(g.from);
        const meta = document.createElement("div");
        meta.className = "muted small";
        meta.style.overflowWrap = "anywhere";
        meta.textContent = [g.message && `“${g.message}”`, g.kind === "Split" ? `your share of ${usdLabel(BigInt(g.amount))}` : "", ago(Number(g.ts))]
          .filter(Boolean)
          .join(" · ");
        left.append(name, meta);
        const right = document.createElement("a");
        right.href = `${d.explorer}/tx/${g.txHash}`;
        right.target = "_blank";
        right.rel = "noopener";
        right.className = "bal";
        right.style.fontSize = "18px";
        right.style.textDecoration = "none";
        right.textContent = g.received === null ? "…" : `+${usdLabel(BigInt(g.received))}`;
        li.append(left, right);
        return li;
      }),
    );
  };
  await render();
  setInterval(() => void render().catch(() => {}), 10_000);
}

main().catch((e) => {
  $("page-error").textContent = e instanceof Error ? e.message : String(e);
  $("page-error").hidden = false;
});

// Wallet page (/wallet): the passkey gate in the open. Create or recover, see balances, back up.
import { signReclaim, usdLabel } from "@beam/shared";
import { formatEther } from "viem";
import { $, balances, copyText, loadConfig, sentDrops, signInCard } from "./pagekit.js";
import { forgetDevice, passkeyErrorMessage, revealRecoveryPhrase } from "./wallet.js";

async function main() {
  const { d } = await loadConfig();
  const wallet = await signInCard($<HTMLInputElement>("signup-name"));
  addEventListener("pagehide", () => wallet.end());
  const me = wallet.account.address;

  $("wallet").hidden = false;
  $<HTMLInputElement>("address").value = me;
  $("copy").onclick = () => copyText(me, $("copy"));
  $<HTMLAnchorElement>("explorer").href = `${d.explorer}/address/${me}`;

  const refresh = async () => {
    const b = await balances(me);
    $("usdc").textContent = usdLabel(b.usdc);
    $("mon").textContent = formatEther(b.mon);
  };
  $("refresh").onclick = () => void refresh();
  await refresh();

  await renderDrops();

  async function renderDrops() {
    const mine = sentDrops();
    $("drops-card").hidden = mine.length === 0;
    const rows = await Promise.all(
      mine.map(async (s) => {
        const r = await fetch(`/api/drops/${s.dropId}?slot=0`);
        const info = r.ok ? ((await r.json()) as { sender: string; closed: boolean; expired: boolean; claimed: number; remaining: string }) : null;
        return { s, info };
      }),
    );
    $("drops").replaceChildren(
      ...rows.map(({ s, info }) => {
        const li = document.createElement("li");
        li.className = "chip";
        li.style.marginTop = "8px";
        li.style.flexWrap = "wrap";
        const left = document.createElement("div");
        const title = document.createElement("div");
        title.style.fontWeight = "700";
        title.textContent = `${usdLabel(BigInt(s.amount))} for ${s.label}`;
        const state = document.createElement("div");
        state.className = "muted small";
        const canReclaim = !!info && !info.closed && info.claimed === 0 && info.sender.toLowerCase() === me.toLowerCase();
        state.textContent = !info
          ? "Not on chain yet"
          : info.claimed > 0
            ? "Claimed ✓"
            : info.closed
              ? "Taken back"
              : info.expired
                ? "Expired: take it back"
                : "Waiting to be claimed";
        left.append(title, state);
        li.append(left);

        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "6px";
        if (info && !info.closed && info.claimed === 0) {
          const copy = document.createElement("button");
          copy.className = "inline ghost";
          copy.textContent = "Copy link";
          copy.onclick = () => copyText(s.link, copy);
          actions.append(copy);
        }
        if (canReclaim) {
          const back = document.createElement("button");
          back.className = "inline";
          back.textContent = "Take it back";
          back.onclick = async () => {
            back.disabled = true;
            back.textContent = "Taking back…";
            try {
              const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
              const senderSig = await signReclaim(d, wallet.account, s.dropId as `0x${string}`, deadline);
              const r = await fetch("/api/relay/reclaim", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ dropId: s.dropId, deadline: deadline.toString(), senderSig }),
              });
              const body = (await r.json()) as { error?: string };
              if (!r.ok) throw new Error(body.error ?? `failed (${r.status})`);
              await Promise.all([refresh(), renderDrops()]);
            } catch (e) {
              state.textContent = e instanceof Error ? e.message : String(e);
              back.disabled = false;
              back.textContent = "Take it back";
            }
          };
          actions.append(back);
        }
        li.append(actions);
        return li;
      }),
    );
  }

  $("reveal").onclick = async () => {
    $("reveal-error").hidden = true;
    try {
      const words = (await revealRecoveryPhrase()).split(" ");
      $("phrase").replaceChildren(
        ...words.map((w) => {
          const li = document.createElement("li");
          li.textContent = w;
          return li;
        }),
      );
      $("phrase").hidden = false;
      $("reveal").hidden = true;
    } catch (e) {
      $("reveal-error").textContent = passkeyErrorMessage(e);
      $("reveal-error").hidden = false;
    }
  };

  $("forget").onclick = () => {
    wallet.end();
    forgetDevice();
    location.reload();
  };
}

main().catch((e) => {
  $("page-error").textContent = e instanceof Error ? e.message : String(e);
  $("page-error").hidden = false;
});

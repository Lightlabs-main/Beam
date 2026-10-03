// Wallet page (/wallet): the passkey gate in the open. Create or recover, see balances and the
// complete indexed activity for this address, back up, and manage claimable drops.
import { signReclaim, usdLabel } from "@beam/shared";
import { formatEther } from "viem";
import { $, balances, copyText, loadConfig, sentDrops, short, signInCard } from "./pagekit.js";
import { forgetDevice, passkeyErrorMessage, revealRecoveryPhrase } from "./wallet.js";

type Activity = {
  id: string;
  kind: "received" | "sent" | "claimed" | "reclaimed";
  giftKind: "Direct" | "Split" | "Chatter" | "Bomb" | "Claim" | "Reclaim";
  amount: string;
  displayName: string;
  message: string;
  ts: string;
  txHash: string;
  counterpart: string | null;
  dropId: string | null;
  status: "settled" | "pending" | "refunded";
};

function ago(ts: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

async function main() {
  const { d } = await loadConfig();
  const wallet = await signInCard($<HTMLInputElement>("signup-name"));
  addEventListener("pagehide", () => wallet.end());
  const me = wallet.account.address;

  $("wallet").hidden = false;
  $<HTMLInputElement>("address").value = me;
  $("copy").onclick = () => copyText(me, $("copy"));
  $<HTMLAnchorElement>("explorer").href = `${d.explorer}/address/${me}`;
  $<HTMLAnchorElement>("earnings").href = `/earnings?creator=${me}`;
  $("earnings").hidden = false;

  let activity: Activity[] = [];

  const refreshBalances = async () => {
    const b = await balances(me);
    $("usdc").textContent = usdLabel(b.usdc);
    $("mon").textContent = formatEther(b.mon);
  };

  const refreshActivity = async () => {
    const res = await fetch(`/api/accounts/${me}/activity?limit=100`);
    if (!res.ok) throw new Error(`activity lookup failed (${res.status})`);
    activity = ((await res.json()) as { activity: Activity[] }).activity;
    renderActivity();
    await renderDrops();
  };

  function renderActivity() {
    $("activity-error").hidden = true;
    $("activity-empty").hidden = activity.length !== 0;
    $("activity").replaceChildren(
      ...activity.map((row) => {
        const li = document.createElement("li");
        li.className = "chip";
        li.style.marginTop = "8px";
        const left = document.createElement("div");
        left.style.minWidth = "0";
        const title = document.createElement("div");
        title.style.fontWeight = "700";
        const verb = row.kind === "received" ? "Received" : row.kind === "claimed" ? "Claimed" : row.kind === "reclaimed" ? "Returned" : "Sent";
        const type = row.giftKind === "Claim" ? "gift claim" : row.giftKind === "Reclaim" ? "drop" : `${row.giftKind.toLowerCase()} gift`;
        title.textContent = `${verb} ${type}`;
        const meta = document.createElement("div");
        meta.className = "muted small";
        meta.style.overflowWrap = "anywhere";
        const detail = row.displayName || (row.counterpart && /^0x[0-9a-fA-F]{40}$/.test(row.counterpart) ? short(row.counterpart) : "");
        meta.textContent = [detail, row.message && `“${row.message}”`, ago(Number(row.ts))].filter(Boolean).join(" · ");
        left.append(title, meta);
        const right = document.createElement("a");
        right.href = `${d.explorer}/tx/${row.txHash}`;
        right.target = "_blank";
        right.rel = "noopener";
        right.className = "bal";
        right.style.fontSize = "18px";
        right.style.textDecoration = "none";
        right.textContent = `${row.kind === "sent" ? "−" : "+"}${usdLabel(BigInt(row.amount))}`;
        li.append(left, right);
        return li;
      }),
    );
  }

  await refreshBalances();
  await refreshActivity().catch((e) => {
    $("activity-error").textContent = e instanceof Error ? e.message : String(e);
    $("activity-error").hidden = false;
  });
  $("refresh").onclick = () => void Promise.all([refreshBalances(), refreshActivity()]);
  setInterval(() => void Promise.all([refreshBalances(), refreshActivity()]).catch(() => {}), 10_000);

  async function renderDrops() {
    const local = sentDrops();
    const known = new Map(local.map((s) => [s.dropId.toLowerCase(), s]));
    for (const row of activity) {
      if (row.kind !== "sent" || !row.dropId || known.has(row.dropId.toLowerCase())) continue;
      known.set(row.dropId.toLowerCase(), {
        dropId: row.dropId,
        link: "",
        label: row.giftKind === "Bomb" ? "chatters" : "chatter",
        amount: row.amount,
        channel: "",
        createdAt: Number(row.ts) * 1000,
      });
    }
    const mine = [...known.values()];
    $("drops-card").hidden = mine.length === 0;
    const rows = await Promise.all(
      mine.map(async (s) => {
        const r = await fetch(`/api/drops/${s.dropId}?slot=0`);
        const info = r.ok
          ? ((await r.json()) as { sender: string; closed: boolean; expired: boolean; claimed: number; remaining: string })
          : null;
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
        if (info && !info.closed && info.claimed === 0 && s.link) {
          const copy = document.createElement("button");
          copy.className = "inline ghost";
          copy.textContent = "Copy link";
          copy.onclick = () => copyText(s.link, copy);
          actions.append(copy);
        } else if (info && !info.closed && info.claimed === 0 && !s.link) {
          const note = document.createElement("span");
          note.className = "muted small";
          note.textContent = "Link is on the sending device";
          actions.append(note);
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
              await Promise.all([refreshBalances(), refreshActivity()]);
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

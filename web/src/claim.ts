// Claim page (/c/<dropId>#k=<claim key>&s=<slot>[&p=<proof>]): a walletless chatter gets a
// passkey wallet and the gift, gaslessly. The claim key never leaves this browser: it signs
// "pay slot S of this drop to <my new address>", which the relayer submits.
import { parseClaimFragment, signClaim, usdLabel } from "@beam/shared";
import { $, loadConfig, short, signInCard } from "./pagekit.js";

type DropInfo = {
  exists: boolean;
  closed: boolean;
  expired: boolean;
  slotClaimed: boolean;
  slots: number;
  perSlot: string;
  kind: number;
  from: { name: string; message: string; recipientLabel: string | null; channel: string } | null;
};

const dropId = (location.pathname.split("/")[2] ?? "") as `0x${string}`;

function gone(title: string, detail: string) {
  $("gift").hidden = true;
  $("gone-title").textContent = title;
  $("gone-detail").textContent = detail;
  $("gone").hidden = false;
}

async function main() {
  const secret = parseClaimFragment(location.hash);
  if (!/^0x[0-9a-fA-F]{64}$/.test(dropId) || !secret) {
    return gone("This link is incomplete", "Ask the sender to copy the whole claim link again. Everything after the # is needed.");
  }
  const { d } = await loadConfig();

  const res = await fetch(`/api/drops/${dropId}?slot=${secret.slot}`);
  if (res.status === 404) return gone("No gift at this link", "Check that the link was copied completely.");
  const drop = (await res.json()) as DropInfo;
  const amount = BigInt(drop.perSlot);

  if (drop.slotClaimed) return gone("Already claimed", "Someone has already opened this link and claimed the gift.");
  if (drop.closed) return gone("This gift was taken back", "The sender took this gift back before it was claimed.");
  if (drop.expired) return gone("This gift has expired", "It wasn't claimed in time, so the money goes back to the sender.");

  const who = drop.from?.name?.trim() || "Someone";
  $("headline").textContent = `${who} sent you ${usdLabel(amount)}`;
  $("from-line").textContent =
    drop.kind === 1 ? `Your share of a Beam Bomb split ${drop.slots} ways.` : `A gift${drop.from?.recipientLabel ? ` for ${drop.from.recipientLabel}` : ""}, on stream.`;
  if (drop.from?.message) {
    $("message").textContent = `“${drop.from.message}”`;
    $("message").hidden = false;
  }
  $<HTMLInputElement>("signup-name").value = drop.from?.recipientLabel?.replace(/^@/, "") ?? "";
  $("gift").hidden = false;

  const wallet = await signInCard($<HTMLInputElement>("signup-name"));
  addEventListener("pagehide", () => wallet.end());
  const me = wallet.account.address;

  const claim = async () => {
    $("claiming").hidden = false;
    $("claim-error").hidden = true;
    $("claim-retry").hidden = true;
    $("claiming-text").textContent = `Claiming ${usdLabel(amount)} into ${short(me)}…`;
    try {
      const claimSig = await signClaim(d, secret.key, dropId, secret.slot, me);
      const r = await fetch("/api/relay/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dropId, slot: secret.slot, recipient: me, proof: secret.proof, claimSig }),
      });
      const body = (await r.json()) as { hash?: string; explorerUrl?: string; error?: string };
      if (!r.ok || !body.hash) throw new Error(friendly(body.error ?? `claim failed (${r.status})`));

      // The link has done its job; drop the secret from the address bar and history.
      history.replaceState(null, "", location.pathname);
      $("gift").hidden = true;
      $("done-title").textContent = `${usdLabel(amount)} is yours`;
      $("done-detail").textContent = `It's in your Beam wallet ${short(me)}. You didn't need any crypto to get it.`;
      $<HTMLAnchorElement>("done-link").href = body.explorerUrl!;
      if (drop.from?.channel) $<HTMLAnchorElement>("gift-back").href = `/g/${drop.from.channel}`;
      else $("gift-back").hidden = true;
      $("done").hidden = false;
    } catch (e) {
      $("claim-error").textContent = e instanceof Error ? e.message : String(e);
      $("claim-error").hidden = false;
      $("claim-retry").hidden = false;
      $("claiming-text").textContent = "Couldn't claim yet.";
    }
  };
  $("claim-retry").onclick = () => void claim();
  await claim();
}

function friendly(error: string): string {
  if (/SlotTaken/.test(error)) return "Someone already claimed this gift.";
  if (/AlreadyClaimed/.test(error)) return "This wallet already claimed a share of this gift.";
  if (/DropClosed/.test(error)) return "The sender took this gift back.";
  if (/DropExpired/.test(error)) return "This gift has expired.";
  if (/InvalidClaim/.test(error)) return "This link doesn't match the gift. Ask the sender for the full link.";
  if (/too many claims/i.test(error)) return "Too many tries from this network. Wait a minute and try again.";
  if (/paused/i.test(error)) return "Claiming is paused for a moment. Please try again shortly.";
  return error;
}

main().catch((e) => {
  $("page-error").textContent = e instanceof Error ? e.message : String(e);
  $("page-error").hidden = false;
});

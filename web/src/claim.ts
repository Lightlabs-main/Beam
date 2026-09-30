// Claim page (/c/<dropId>#…): a walletless chatter gets a passkey wallet and the gift, gaslessly.
//   gift-a-chatter:  #k=<claim key>&s=<slot>[&p=<proof>]
//   Beam Bomb:       #b=<seed>&n=<slots>   (every slot's key derives from the seed)
// Secrets live only in the fragment and this browser. The claim key signs "pay slot S of this
// drop to <my new address>", which the relayer submits.
import {
  deriveClaimKeys,
  firstFreeSlot,
  merkleProof,
  parseBombFragment,
  parseClaimFragment,
  signClaim,
  usdLabel,
} from "@beam/shared";
import type { Hex } from "viem";
import { $, loadConfig, short, signInCard } from "./pagekit.js";

type DropInfo = {
  exists: boolean;
  closed: boolean;
  expired: boolean;
  slotClaimed: boolean;
  slots: number;
  claimed: number;
  claimedSlots: string;
  perSlot: string;
  kind: number;
  from: { name: string; message: string; recipientLabel: string | null; channel: string } | null;
};

const dropId = (location.pathname.split("/")[2] ?? "") as Hex;

function gone(title: string, detail: string) {
  $("gift").hidden = true;
  $("gone-title").textContent = title;
  $("gone-detail").textContent = detail;
  $("gone").hidden = false;
}

async function fetchDrop(slot = 0): Promise<DropInfo | null> {
  const res = await fetch(`/api/drops/${dropId}?slot=${slot}`);
  if (res.status === 404) return null;
  return (await res.json()) as DropInfo;
}

async function main() {
  const single = parseClaimFragment(location.hash);
  const bomb = parseBombFragment(location.hash);
  if (!/^0x[0-9a-fA-F]{64}$/.test(dropId) || (!single && !bomb)) {
    return gone("This link is incomplete", "Ask the sender to copy the whole link again. Everything after the # is needed.");
  }
  const { d } = await loadConfig();
  const derived = bomb ? deriveClaimKeys(bomb.seed, bomb.slots) : null;

  const drop = await fetchDrop(single?.slot ?? 0);
  if (!drop) return gone("No gift at this link", "Check that the link was copied completely.");
  const amount = BigInt(drop.perSlot);
  const left = drop.slots - drop.claimed;

  if (single && drop.slotClaimed) return gone("Already claimed", "Someone has already opened this link and claimed the gift.");
  if (bomb && left <= 0) return gone("The Beam Bomb is all claimed", "Every share has been claimed. Be quicker next time! 💣");
  if (drop.closed) return gone("This gift was taken back", "The sender took this gift back before it was claimed.");
  if (drop.expired) return gone("This gift has expired", "It wasn't claimed in time, so the money goes back to the sender.");

  const who = drop.from?.name?.trim() || "Someone";
  if (bomb) {
    $("headline").textContent = `${who} dropped a Beam Bomb 💣`;
    $("from-line").textContent = `${usdLabel(amount)} each for the first ${drop.slots} chatters. ${left} left.`;
  } else {
    $("headline").textContent = `${who} sent you ${usdLabel(amount)}`;
    $("from-line").textContent = `A gift${drop.from?.recipientLabel ? ` for ${drop.from.recipientLabel}` : ""}, on stream.`;
  }
  if (drop.from?.message) {
    $("message").textContent = `“${drop.from.message}”`;
    $("message").hidden = false;
  }
  $<HTMLInputElement>("signup-name").value = drop.from?.recipientLabel?.replace(/^@/, "") ?? "";
  $("gift").hidden = false;

  const wallet = await signInCard($<HTMLInputElement>("signup-name"));
  addEventListener("pagehide", () => wallet.end());
  const me = wallet.account.address;

  /** Which slot to claim now, and with which key and proof. */
  const lostRaces = new Set<number>();
  async function pickSlot(): Promise<{ slot: number; key: Hex; proof: Hex[] } | null> {
    if (single) return single;
    const fresh = await fetchDrop();
    if (!fresh) return null;
    const slot = firstFreeSlot(BigInt(fresh.claimedSlots), fresh.slots, lostRaces);
    if (slot < 0) return null;
    return { slot, key: derived!.keys[slot]!, proof: merkleProof(derived!.leaves, slot) };
  }

  const claim = async (): Promise<void> => {
    $("claiming").hidden = false;
    $("claim-error").hidden = true;
    $("claim-retry").hidden = true;
    $("claiming-text").textContent = `Claiming ${usdLabel(amount)} into ${short(me)}…`;
    try {
      const pick = await pickSlot();
      if (!pick) return gone("The Beam Bomb is all claimed", "Every share went before you got there. Be quicker next time! 💣");
      const claimSig = await signClaim(d, pick.key, dropId, pick.slot, me);
      const r = await fetch("/api/relay/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dropId, slot: pick.slot, recipient: me, proof: pick.proof, claimSig }),
      });
      const body = (await r.json()) as { hash?: string; explorerUrl?: string; error?: string };
      // Two chatters grabbed the same bomb slot at once: take the next one.
      if (bomb && /SlotTaken/.test(body.error ?? "") && lostRaces.size < drop.slots) {
        lostRaces.add(pick.slot);
        return claim();
      }
      if (!r.ok || !body.hash) throw new Error(friendly(body.error ?? `claim failed (${r.status})`));

      // The link has done its job for this device; drop the secret from the address bar and history.
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
  if (/AlreadyClaimed/.test(error)) return "This wallet already has its share of this Beam Bomb.";
  if (/DropClosed/.test(error)) return "This gift is closed: it was fully claimed or taken back.";
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

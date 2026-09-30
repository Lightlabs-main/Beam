// Gift page (/g/<creator>): passkey wallet → amount + message → gasless gift through the relayer.
import {
  DropKind,
  MAX_LABEL_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_NAME_BYTES,
  claimLink,
  makeClaimKeys,
  parseUsdc,
  signDrop,
  signGift,
  usdLabel,
} from "@beam/shared";
import { $, balances, copyText, loadConfig, randomSalt, saveSentDrop, short, signInCard } from "./pagekit.js";

/** Unclaimed chatter gifts can be taken back after this (the sender can also take them back any time). */
const CHATTER_TTL_SECONDS = 7n * 24n * 60n * 60n;

const NAME_KEY = "beam.name";
const creator = location.pathname.split("/")[2] ?? "";
const bytes = (s: string) => new TextEncoder().encode(s).length;

function showError(id: string, message: string | null) {
  const el = $(id);
  el.textContent = message ?? "";
  el.hidden = !message;
}

async function main() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(creator)) return showError("page-error", "This gift link is incomplete. Scan the QR on the stream again.");
  $("creator").textContent = short(creator);

  const { cfg, d } = await loadConfig();
  const minUnits = parseUsdc(cfg.minGiftUsdc);

  const savedName = (() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  })();
  $<HTMLInputElement>("signup-name").value = savedName;

  const wallet = await signInCard($<HTMLInputElement>("signup-name"));
  addEventListener("pagehide", () => wallet.end());
  const me = wallet.account.address;
  $("wallet").hidden = false;
  $("me").textContent = short(me);
  $<HTMLInputElement>("name").value = $<HTMLInputElement>("signup-name").value.trim() || savedName;

  let balance = 0n;
  let polling: ReturnType<typeof setInterval> | undefined;

  const refresh = async () => {
    balance = (await balances(me)).usdc;
    $("balance").textContent = usdLabel(balance);
    const needsFunds = balance < minUnits;
    $("fund").hidden = !needsFunds;
    if (!$("sent").hidden) return;
    $("compose").hidden = needsFunds;
    if (needsFunds && !polling) polling = setInterval(() => void refresh().catch(() => {}), 5000);
    if (!needsFunds && polling) {
      clearInterval(polling);
      polling = undefined;
    }
    updateSend();
  };

  // Funding: honest about timing. Card funding (Ramp) is enabled once its production key lands.
  $<HTMLInputElement>("fund-address").value = me;
  $("fund-copy").onclick = () => copyText(me, $("fund-copy"));
  $("fund-how").innerHTML =
    cfg.network === "testnet"
      ? `This is Monad testnet. Get free test USDC at <a href="https://faucet.circle.com" target="_blank" rel="noopener">faucet.circle.com</a> (choose <b>Monad Testnet</b>) and paste this address:`
      : `Send USDC on the <b>Monad</b> network from an exchange or another wallet to this address:`;

  // ---- compose
  let amount = parseUsdc("1");
  let forChatter = false;
  const amountButtons = [...document.querySelectorAll<HTMLButtonElement>("button[data-amount]")];
  const forButtons = [...document.querySelectorAll<HTMLButtonElement>("button[data-for]")];
  const custom = $<HTMLInputElement>("custom");
  const nameInput = $<HTMLInputElement>("name");
  const labelInput = $<HTMLInputElement>("label");
  const message = $<HTMLTextAreaElement>("message");
  const send = $<HTMLButtonElement>("send");

  function updateSend() {
    $("name-count").textContent = `${bytes(nameInput.value)}/${MAX_NAME_BYTES}`;
    $("label-count").textContent = `${bytes(labelInput.value)}/${MAX_LABEL_BYTES}`;
    $("message-count").textContent = `${bytes(message.value)}/${MAX_MESSAGE_BYTES}`;
    let problem: string | null = null;
    if (amount < minUnits) problem = `The smallest gift is ${usdLabel(minUnits)}.`;
    else if (amount > balance) problem = `You have ${usdLabel(balance)}. Add money or pick a smaller amount.`;
    else if (bytes(nameInput.value) > MAX_NAME_BYTES) problem = "That name is too long.";
    else if (bytes(message.value) > MAX_MESSAGE_BYTES) problem = "That message is too long.";
    else if (forChatter && !labelInput.value.trim()) problem = "Add the chatter's name so the stream knows who it's for.";
    else if (forChatter && bytes(labelInput.value) > MAX_LABEL_BYTES) problem = "That chatter name is too long.";
    send.disabled = problem !== null;
    send.textContent = forChatter ? `Gift ${usdLabel(amount)} to ${labelInput.value.trim() || "a chatter"}` : `Send ${usdLabel(amount)}`;
    showError("send-error", balance >= minUnits && (!forChatter || labelInput.value.trim()) ? problem : null);
  }

  for (const b of forButtons) {
    b.onclick = () => {
      forChatter = b.dataset.for === "chatter";
      for (const x of forButtons) x.setAttribute("aria-pressed", String(x === b));
      $("chatter-fields").hidden = !forChatter;
      if (forChatter) labelInput.focus();
      updateSend();
    };
  }
  labelInput.oninput = updateSend;

  for (const b of amountButtons) {
    b.onclick = () => {
      amount = parseUsdc(b.dataset.amount!);
      custom.value = "";
      for (const x of amountButtons) x.setAttribute("aria-pressed", String(x === b));
      updateSend();
    };
  }
  custom.oninput = () => {
    for (const x of amountButtons) x.setAttribute("aria-pressed", "false");
    try {
      amount = custom.value.trim() ? parseUsdc(custom.value.trim()) : 0n;
    } catch {
      amount = 0n;
    }
    updateSend();
  };
  nameInput.oninput = message.oninput = updateSend;

  $<HTMLFormElement>("compose").onsubmit = async (e) => {
    e.preventDefault();
    if (send.disabled) return;
    const meta = { displayName: nameInput.value.trim(), message: message.value.trim(), actionCode: 1 };
    try {
      localStorage.setItem(NAME_KEY, meta.displayName);
    } catch {}
    send.disabled = true;
    send.innerHTML = `<span class="spinner"></span>Sending…`;
    showError("send-error", null);
    const started = performance.now();
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
    try {
      let body: { hash?: string; explorerUrl?: string; error?: string; dropId?: string };
      let claimUrl: string | null = null;
      const label = labelInput.value.trim();
      if (!forChatter) {
        const auth = await signGift(d, wallet.account, { to: creator as `0x${string}`, meta, value: amount, validBefore, salt: randomSalt() });
        body = await post("/api/relay/gift", { to: creator, meta, auth });
      } else {
        // The claim key is born and stays in this browser; only its hash (the slot root) goes on-chain.
        const { keys, root } = makeClaimKeys(1);
        const params = {
          channel: creator as `0x${string}`,
          slots: 1,
          slotRoot: root,
          expiry: BigInt(Math.floor(Date.now() / 1000)) + CHATTER_TTL_SECONDS,
          recipientLabel: label,
        };
        const { dropId, auth } = await signDrop(d, wallet.account, {
          kind: DropKind.Chatter,
          params,
          meta,
          value: amount,
          validBefore,
          salt: randomSalt(),
        });
        claimUrl = claimLink(location.origin, dropId, 0, keys[0]!, []);
        // Saved before sending: if this tab closes, the sender still has the link.
        saveSentDrop({ dropId, link: claimUrl, label, amount: amount.toString(), channel: creator, createdAt: Date.now() });
        body = await post("/api/relay/drop", { kind: "chatter", params, meta, auth });
      }
      if (!body.hash) throw new Error(friendly(body.error ?? "send failed"));
      const ms = Math.round(performance.now() - started);
      $("sent-title").textContent = forChatter ? `${usdLabel(amount)} for ${label} is on stream` : `${usdLabel(amount)} is on stream`;
      $("sent-detail").textContent = forChatter
        ? `Settled on Monad in ${(ms / 1000).toFixed(1)} s. The money waits safely until ${label} claims it.`
        : `Settled on Monad in ${(ms / 1000).toFixed(1)} s. The creator already has it.`;
      $<HTMLAnchorElement>("sent-link").href = body.explorerUrl!;
      $("claim-share").hidden = !claimUrl;
      if (claimUrl) {
        $("claim-for").textContent = label;
        $<HTMLInputElement>("claim-url").value = claimUrl;
        $("claim-copy").onclick = () => copyText(claimUrl!, $("claim-copy"));
        const share = $("claim-native-share");
        share.hidden = !("share" in navigator);
        share.onclick = () => void navigator.share?.({ title: "A gift for you on Beam", text: `${label}, you got a gift!`, url: claimUrl! }).catch(() => {});
      }
      $("compose").hidden = true;
      $("sent").hidden = false;
      message.value = "";
      void refresh();
    } catch (err) {
      showError("send-error", err instanceof Error ? err.message : String(err));
    } finally {
      updateSend();
    }
  };

  $("again").onclick = () => {
    $("sent").hidden = true;
    void refresh();
  };

  await refresh();
}

async function post(path: string, payload: unknown): Promise<{ hash?: string; explorerUrl?: string; error?: string; dropId?: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const body = (await res.json()) as { hash?: string; explorerUrl?: string; error?: string; dropId?: string };
  if (!res.ok) throw new Error(friendly(body.error ?? `send failed (${res.status})`));
  return body;
}

function friendly(error: string): string {
  if (/exceeds balance/i.test(error)) return "Not enough USDC for that gift yet.";
  if (/too many gifts/i.test(error)) return "You're gifting fast! Wait a moment and try again.";
  if (/paused/i.test(error)) return "Gifting is paused for a moment. Please try again shortly.";
  if (/invalid signature|expired/i.test(error)) return "That gift couldn't be verified. Please try again.";
  return error;
}

main().catch((e) => showError("page-error", e instanceof Error ? e.message : String(e)));


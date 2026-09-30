// Gift page (/g/<creator>): passkey wallet → amount + message → gasless gift through the relayer.
import { MAX_MESSAGE_BYTES, MAX_NAME_BYTES, parseUsdc, signGift, usdLabel } from "@beam/shared";
import { $, balances, copyText, loadConfig, randomSalt, short, signInCard } from "./pagekit.js";

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
  const amountButtons = [...document.querySelectorAll<HTMLButtonElement>(".amounts button")];
  const custom = $<HTMLInputElement>("custom");
  const nameInput = $<HTMLInputElement>("name");
  const message = $<HTMLTextAreaElement>("message");
  const send = $<HTMLButtonElement>("send");

  function updateSend() {
    $("name-count").textContent = `${bytes(nameInput.value)}/${MAX_NAME_BYTES}`;
    $("message-count").textContent = `${bytes(message.value)}/${MAX_MESSAGE_BYTES}`;
    let problem: string | null = null;
    if (amount < minUnits) problem = `The smallest gift is ${usdLabel(minUnits)}.`;
    else if (amount > balance) problem = `You have ${usdLabel(balance)}. Add money or pick a smaller amount.`;
    else if (bytes(nameInput.value) > MAX_NAME_BYTES) problem = "That name is too long.";
    else if (bytes(message.value) > MAX_MESSAGE_BYTES) problem = "That message is too long.";
    send.disabled = problem !== null;
    send.textContent = `Send ${usdLabel(amount)}`;
    showError("send-error", balance >= minUnits ? problem : null);
  }

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
    try {
      const auth = await signGift(d, wallet.account, {
        to: creator as `0x${string}`,
        meta,
        value: amount,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
        salt: randomSalt(),
      });
      const res = await fetch("/api/relay/gift", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: creator, meta, auth }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      const body = (await res.json()) as { hash?: string; explorerUrl?: string; error?: string };
      if (!res.ok || !body.hash) throw new Error(friendly(body.error ?? `send failed (${res.status})`));
      const ms = Math.round(performance.now() - started);
      $("sent-title").textContent = `${usdLabel(amount)} is on stream`;
      $("sent-detail").textContent = `Settled on Monad in ${(ms / 1000).toFixed(1)} s. The creator already has it.`;
      $<HTMLAnchorElement>("sent-link").href = body.explorerUrl!;
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

function friendly(error: string): string {
  if (/exceeds balance/i.test(error)) return "Not enough USDC for that gift yet.";
  if (/too many gifts/i.test(error)) return "You're gifting fast! Wait a moment and try again.";
  if (/paused/i.test(error)) return "Gifting is paused for a moment. Please try again shortly.";
  if (/invalid signature|expired/i.test(error)) return "That gift couldn't be verified. Please try again.";
  return error;
}

main().catch((e) => showError("page-error", e instanceof Error ? e.message : String(e)));


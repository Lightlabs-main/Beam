// Wallet page (/wallet): the passkey gate in the open. Create or recover, see balances, back up.
import { usdLabel } from "@beam/shared";
import { formatEther } from "viem";
import { $, balances, copyText, loadConfig, signInCard } from "./pagekit.js";
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

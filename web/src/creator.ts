// Creator dashboard (/creator): passkey wallet → OBS link, chat command, signed settings.
import { BPS, type CreatorConfig, MAX_SHARES, type SplitShare, checkCreatorConfig, parseUsdc, signCreatorConfig } from "@beam/shared";
import { type Address, getAddress, isAddress } from "viem";
import { $, copyText, loadConfig, signInCard } from "./pagekit.js";

type Stored = { config: CreatorConfig | null };

async function main() {
  const { d } = await loadConfig();
  const wallet = await signInCard($<HTMLInputElement>("signup-name"));
  addEventListener("pagehide", () => wallet.end());
  const me = getAddress(wallet.account.address);
  $("dash").hidden = false;

  const origin = location.origin;
  const overlayUrl = `${origin}/overlay?creator=${me}`;
  const giftUrl = `${origin}/g/${me}`;
  $<HTMLInputElement>("overlay-url").value = overlayUrl;
  $<HTMLAnchorElement>("overlay-preview").href = overlayUrl;
  $<HTMLInputElement>("gift-url").value = giftUrl;
  $<HTMLInputElement>("nightbot").value = `!commands add !gift Send a gift that pops up on stream: ${giftUrl}`;
  $<HTMLInputElement>("streamelements").value = `!cmd add gift Send a gift that pops up on stream: ${giftUrl}`;
  $("overlay-copy").onclick = () => copyText(overlayUrl, $("overlay-copy"));
  $("gift-copy").onclick = () => copyText(giftUrl, $("gift-copy"));
  $("nightbot-copy").onclick = () => copyText($<HTMLInputElement>("nightbot").value, $("nightbot-copy"));
  $("se-copy").onclick = () => copyText($<HTMLInputElement>("streamelements").value, $("se-copy"));

  // ---- settings
  const stored = (await (await fetch(`/api/creators/${me}/config`)).json()) as Stored;
  const current = stored.config;
  $<HTMLInputElement>("display").value = current?.displayName ?? $<HTMLInputElement>("signup-name").value.trim();
  $<HTMLInputElement>("goal").value = current?.goal?.usdc ?? "";
  $<HTMLInputElement>("goal-title").value = current?.goal?.title ?? "";
  $<HTMLInputElement>("goal-reset").checked = !current?.goal;

  const sharesBox = $("shares");
  const addShare = (s?: SplitShare) => {
    const row = document.createElement("div");
    row.className = "card share";
    row.style.padding = "12px";
    row.style.marginTop = "8px";
    row.innerHTML = `
      <label>Who <span class="count">label</span></label><input class="s-label" maxlength="24" placeholder="Mod, Editor, Charity…" />
      <label>Their wallet address</label><input class="s-address mono" placeholder="0x…" autocomplete="off" spellcheck="false" />
      <label>Share (%)</label><input class="s-pct" inputmode="decimal" placeholder="10" />
      <button type="button" class="ghost s-remove">Remove</button>`;
    (row.querySelector(".s-label") as HTMLInputElement).value = s?.label ?? "";
    (row.querySelector(".s-address") as HTMLInputElement).value = s?.address ?? "";
    (row.querySelector(".s-pct") as HTMLInputElement).value = s ? String(s.bps / 100) : "";
    (row.querySelector(".s-remove") as HTMLButtonElement).onclick = () => {
      row.remove();
      update();
    };
    row.oninput = update;
    sharesBox.append(row);
    update();
  };
  $("add-share").onclick = () => addShare();
  for (const s of current?.shares ?? []) addShare(s);

  function readShares(): SplitShare[] {
    return [...sharesBox.querySelectorAll<HTMLElement>(".share")].map((row) => {
      const pct = (row.querySelector(".s-pct") as HTMLInputElement).value.trim();
      const address = (row.querySelector(".s-address") as HTMLInputElement).value.trim();
      if (!isAddress(address)) throw new Error("Each share needs a valid wallet address (0x…).");
      const bps = Math.round(Number(pct) * 100);
      if (!Number.isFinite(bps) || bps <= 0) throw new Error("Each share needs a percentage above 0.");
      return { address: getAddress(address) as Address, bps, label: (row.querySelector(".s-label") as HTMLInputElement).value.trim() };
    });
  }

  function update() {
    $("add-share").hidden = sharesBox.children.length >= MAX_SHARES;
    try {
      const others = readShares().reduce((a, s) => a + s.bps, 0);
      $("keep").textContent = others ? `You keep ${((BPS - others) / 100).toFixed(2).replace(/\.00$/, "")}% of every gift.` : "";
    } catch {
      $("keep").textContent = "";
    }
    $("saved").hidden = true;
  }

  $<HTMLFormElement>("settings").onsubmit = async (e) => {
    e.preventDefault();
    const save = $<HTMLButtonElement>("save");
    $("save-error").hidden = true;
    try {
      const goalRaw = $<HTMLInputElement>("goal").value.trim();
      if (goalRaw) parseUsdc(goalRaw);
      const reset = $<HTMLInputElement>("goal-reset").checked;
      const config: CreatorConfig = {
        creator: me,
        displayName: $<HTMLInputElement>("display").value.trim(),
        goal: goalRaw
          ? {
              usdc: goalRaw,
              title: $<HTMLInputElement>("goal-title").value.trim() || "Stream goal",
              since: reset || !current?.goal ? Math.floor(Date.now() / 1000) : current.goal.since,
            }
          : null,
        shares: readShares(),
        updatedAt: Date.now(),
      };
      checkCreatorConfig(config);
      save.disabled = true;
      save.textContent = "Signing…";
      const signature = await signCreatorConfig(d, wallet.account, config);
      const r = await fetch(`/api/creators/${me}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, signature }),
      });
      const body = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? `save failed (${r.status})`);
      $<HTMLInputElement>("goal-reset").checked = false;
      $("saved").hidden = false;
    } catch (err) {
      $("save-error").textContent = err instanceof Error ? err.message : String(err);
      $("save-error").hidden = false;
    } finally {
      save.disabled = false;
      save.textContent = "Save settings";
    }
  };
}

main().catch((e) => {
  $("page-error").textContent = e instanceof Error ? e.message : String(e);
  $("page-error").hidden = false;
});

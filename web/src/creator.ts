// Creator setup (/creator): six steps, each ticking itself when it's really done.
//   1 wallet (passkey) · 2 channel · 3 OBS (ticks when the overlay connects) · 4 !gift in chat
//   5 test gift · 6 share. Goal and splits live under "More settings".
import {
  BPS,
  type CreatorConfig,
  MAX_SHARES,
  type SplitShare,
  type StreamLink,
  checkCreatorConfig,
  parseStreamLink,
  parseUsdc,
  signCreatorConfig,
  signGift,
  usdLabel,
} from "@beam/shared";
import { type Address, getAddress, isAddress } from "viem";
import { downloadObsSetup } from "./obs.js";
import { $, balances, copyText, loadConfig, randomSalt, short, signInCard } from "./pagekit.js";

const STREAM_HELP: Record<StreamLink["platform"], [string, string, string]> = {
  twitch: ["Twitch username", "tunde_live", "Your username, or paste your twitch.tv link."],
  kick: ["Kick username", "tunde-live", "Your username, or paste your kick.com link."],
  youtube: [
    "YouTube live link or channel ID",
    "https://youtube.com/watch?v=… or UC…",
    "Paste the link of your live video, or your channel ID (YouTube Studio → Settings → Channel → Advanced; it starts with UC).",
  ],
};

const local = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

async function main() {
  const { cfg, d } = await loadConfig();
  const wallet = await signInCard($<HTMLInputElement>("signup-name"));
  addEventListener("pagehide", () => wallet.end());
  const me = getAddress(wallet.account.address);
  const origin = location.origin;
  $("steps").hidden = false;

  // Links
  const overlayUrl = `${origin}/overlay?creator=${me}`;
  const giftUrl = `${origin}/g/${me}`;
  const watchUrl = `${origin}/watch/${me}`;
  $("me").textContent = short(me);
  $<HTMLAnchorElement>("earnings-link").href = `/earnings?creator=${me}`;
  $<HTMLAnchorElement>("studio-link").href = `/studio?creator=${me}`;
  $<HTMLInputElement>("overlay-url").value = overlayUrl;
  $<HTMLInputElement>("gift-url").value = giftUrl;
  $<HTMLInputElement>("watch-url").value = watchUrl;
  $<HTMLAnchorElement>("watch-open").href = watchUrl;
  $<HTMLInputElement>("nightbot").value = `!commands add !gift Send a gift that pops up on stream: ${giftUrl}`;
  $("overlay-copy").onclick = () => copyText(overlayUrl, $("overlay-copy"));
  $("gift-copy").onclick = () => copyText(giftUrl, $("gift-copy"));
  $("watch-copy").onclick = () => copyText(watchUrl, $("watch-copy"));
  $("nightbot-copy").onclick = () => copyText($<HTMLInputElement>("nightbot").value, $("nightbot-copy"));

  let provenTwitch: string | null = null;

  // ---- signed settings: one source of truth, saved by patching it
  let saved: CreatorConfig | null = ((await (await fetch(`/api/creators/${me}/config`)).json()) as { config: CreatorConfig | null }).config;

  async function save(patch: Partial<CreatorConfig>) {
    const config: CreatorConfig = {
      creator: me,
      displayName: saved?.displayName ?? "",
      goal: saved?.goal ?? null,
      shares: saved?.shares ?? [],
      stream: saved?.stream ?? null,
      chatBot: saved?.chatBot ?? false,
      ...patch,
      updatedAt: Math.max(Date.now(), (saved?.updatedAt ?? 0) + 1),
    };
    checkCreatorConfig(config);
    const signature = await signCreatorConfig(d, wallet.account, config);
    const r = await fetch(`/api/creators/${me}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config, signature }),
    });
    const body = (await r.json()) as { error?: string };
    if (!r.ok) throw new Error(body.error ?? `save failed (${r.status})`);
    saved = config;
    render();
  }

  const done = {
    channel: () => !!saved?.displayName,
    obs: false,
    chat: () =>
      saved?.stream?.platform === "twitch" && cfg.twitchBot && provenTwitch === saved.stream.channel
        ? !!saved.chatBot
        : local.get(`beam.chatDone.${me}`) === "1",
    test: () => local.get(`beam.testDone.${me}`) === "1",
  };

  function mark(id: string, isDone: boolean, n: number) {
    $(id).classList.toggle("done", isDone);
    $(id).querySelector(".num")!.textContent = isDone ? "✓" : String(n);
  }

  function render() {
    mark("step-channel", done.channel(), 2);
    mark("step-obs", done.obs, 3);
    mark("step-chat", done.chat(), 4);
    mark("step-test", done.test(), 5);
    mark("step-share", done.channel() && done.obs, 6);
    const count = 1 + [done.channel(), done.obs, done.chat(), done.test(), done.channel() && done.obs].filter(Boolean).length;
    $("progress").textContent = count >= 6 ? "All set. Go live! 🎉" : `${count} of 6 done. Each step ticks itself when it's really done.`;

    // Step 4 adapts to where they stream and whether Beam's bot is running.
    const onTwitch = saved?.stream?.platform === "twitch";
    const proven = onTwitch && provenTwitch === saved?.stream?.channel;
    const twitchBot = onTwitch && cfg.twitchBot && proven;
    $("chat-bot").hidden = !twitchBot;
    $("chat-manual").hidden = !!twitchBot;
    if (twitchBot) {
      $("bot-toggle").textContent = saved?.chatBot ? "Turn off !gift" : "Turn on !gift";
      $("bot-mod").hidden = !saved?.chatBot;
      $("mod-cmd").textContent = `/mod ${cfg.twitchBot!.login}`;
    } else {
      $("manual-why").textContent = !onTwitch
        ? "For YouTube and Kick, add Nightbot to your channel (free, 2 minutes):"
        : cfg.twitchBot && !proven
          ? "Connect with Twitch in step 2 first, and this becomes one switch. Or use Nightbot (free, 2 minutes):"
          : "Beam's own Twitch bot isn't switched on for this site yet, so use Nightbot for now (free, 2 minutes):";
    }
  }

  // ---- step 2: channel
  const platform = $<HTMLSelectElement>("platform");
  const channel = $<HTMLInputElement>("channel");
  // Twitch channels are proven by logging in with Twitch (when this site has a Twitch app).
  const twitchConnect = () => platform.value === "twitch" && cfg.twitchConnect;
  const showPlatform = () => {
    const p = platform.value as StreamLink["platform"] | "";
    $("twitch-connect").hidden = !twitchConnect();
    $("channel-field").hidden = !p || twitchConnect();
    $("twitch-status").textContent = provenTwitch ? `✓ Connected as ${provenTwitch}` : "";
    $("twitch-button").textContent = provenTwitch ? "Connect a different Twitch account" : "Connect with Twitch";
    if (!p) return;
    const [label, placeholder, help] = STREAM_HELP[p];
    $("channel-label").textContent = label;
    channel.placeholder = placeholder;
    $("channel-help").textContent = help;
  };
  $<HTMLInputElement>("display").value = saved?.displayName || $<HTMLInputElement>("signup-name").value.trim();
  platform.value = saved?.stream?.platform ?? "twitch";
  channel.value = saved?.stream?.channel ?? "";
  platform.onchange = showPlatform;
  showPlatform();
  $("save-channel").onclick = async () => {
    const button = $<HTMLButtonElement>("save-channel");
    $("channel-error").hidden = true;
    try {
      const displayName = $<HTMLInputElement>("display").value.trim();
      if (!displayName) throw new Error("Add the name viewers see.");
      const p = platform.value as StreamLink["platform"] | "";
      if (twitchConnect() && !provenTwitch) throw new Error("Connect with Twitch first.");
      const stream = twitchConnect() ? { platform: "twitch" as const, channel: provenTwitch! } : p ? parseStreamLink(p, channel.value) : null;
      if (p && !stream) throw new Error(`That doesn't look like a ${STREAM_HELP[p][0]}.`);
      button.disabled = true;
      button.textContent = "Saving…";
      await save({ displayName, stream, chatBot: stream?.platform === "twitch" ? (saved?.chatBot ?? false) : false });
      button.textContent = "Saved ✓";
      setTimeout(() => (button.textContent = "Save"), 1500);
    } catch (e) {
      $("channel-error").textContent = e instanceof Error ? e.message : String(e);
      $("channel-error").hidden = false;
      button.textContent = "Save";
    } finally {
      button.disabled = false;
    }
  };

  $("twitch-button").onclick = () => {
    // Keep the name typed so far; Twitch sends them straight back here.
    local.set(`beam.pendingName.${me}`, $<HTMLInputElement>("display").value.trim());
    location.href = `/twitch/link/start?creator=${me}`;
  };
  const status0 = (await (await fetch(`/api/creators/${me}/status`)).json()) as { twitch: string | null };
  provenTwitch = status0.twitch;
  showPlatform();
  // Back from Twitch: save the proven channel straight away.
  const back = new URLSearchParams(location.search).get("twitch");
  if (back) {
    history.replaceState(null, "", location.pathname);
    if (back === "failed") {
      $("channel-error").textContent = "Twitch didn't confirm the login. Try Connect with Twitch again.";
      $("channel-error").hidden = false;
    } else if (provenTwitch && saved?.stream?.channel !== provenTwitch) {
      const pending = local.get(`beam.pendingName.${me}`);
      if (pending) $<HTMLInputElement>("display").value = pending;
      $("save-channel").click();
    }
  }

  // ---- step 3: OBS. Ticks when this creator's overlay is actually connected somewhere.
  $("obs-download").onclick = () => downloadObsSetup(overlayUrl);
  const pollOverlay = async () => {
    try {
      const { overlays } = (await (await fetch(`/api/creators/${me}/status`)).json()) as { overlays: number };
      if (overlays > 0) local.set(`beam.obsSeen.${me}`, "1");
      done.obs = overlays > 0 || local.get(`beam.obsSeen.${me}`) === "1";
      $("obs-status").textContent =
        overlays > 0 ? "✓ Your overlay is live in OBS." : done.obs ? "✓ Your overlay has connected before. Open OBS to see it." : "Waiting for your overlay to connect…";
      render();
    } catch {}
  };
  await pollOverlay();
  setInterval(() => void pollOverlay(), 4000);

  // ---- step 4: !gift
  $("bot-toggle").onclick = async () => {
    const button = $<HTMLButtonElement>("bot-toggle");
    button.disabled = true;
    try {
      await save({ chatBot: !saved?.chatBot });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      button.disabled = false;
    }
  };
  $<HTMLInputElement>("manual-done").checked = local.get(`beam.chatDone.${me}`) === "1";
  $<HTMLInputElement>("manual-done").onchange = (e) => {
    local.set(`beam.chatDone.${me}`, (e.target as HTMLInputElement).checked ? "1" : "0");
    render();
  };

  // ---- step 5: a real, minimum-size gift to yourself; the overlay alert comes from its event.
  const testUnits = parseUsdc(cfg.minGiftUsdc);
  $("test-amount").textContent = usdLabel(testUnits);
  const showBalance = async () => {
    const bal = (await balances(me)).usdc;
    $("test-balance").textContent = usdLabel(bal);
    return bal;
  };
  await showBalance();
  $("test-gift").onclick = async () => {
    const button = $<HTMLButtonElement>("test-gift");
    const result = $("test-result");
    result.hidden = false;
    if ((await showBalance()) < testUnits) {
      result.innerHTML = "";
      result.append(
        `You need at least ${usdLabel(testUnits)} in your wallet. Open your `,
        Object.assign(document.createElement("a"), { href: `/g/${me}`, textContent: "gift page" }),
        " to add some.",
      );
      return;
    }
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const meta = { displayName: saved?.displayName || "Test", message: "Test gift: your Beam alert works!", actionCode: 1 };
      const auth = await signGift(d, wallet.account, { to: me, meta, value: testUnits, validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), salt: randomSalt() });
      const r = await fetch("/api/relay/gift", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: me, meta, auth }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      const body = (await r.json()) as { hash?: string; error?: string };
      if (!r.ok || !body.hash) throw new Error(body.error ?? `failed (${r.status})`);
      result.textContent = "Sent! Look at OBS: the confetti should be on screen now.";
      local.set(`beam.testDone.${me}`, "1");
      render();
      await showBalance();
    } catch (e) {
      result.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      button.disabled = false;
      button.textContent = "Send a test gift";
    }
  };

  // ---- more settings: goal and splits
  $<HTMLInputElement>("goal").value = saved?.goal?.usdc ?? "";
  $<HTMLInputElement>("goal-title").value = saved?.goal?.title ?? "";
  $<HTMLInputElement>("goal-reset").checked = !saved?.goal;
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
      updateShares();
    };
    row.oninput = updateShares;
    sharesBox.append(row);
    updateShares();
  };
  $("add-share").onclick = () => addShare();
  for (const s of saved?.shares ?? []) addShare(s);

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
  function updateShares() {
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
    const button = $<HTMLButtonElement>("save");
    $("save-error").hidden = true;
    try {
      const goalRaw = $<HTMLInputElement>("goal").value.trim();
      if (goalRaw) parseUsdc(goalRaw);
      const reset = $<HTMLInputElement>("goal-reset").checked;
      button.disabled = true;
      button.textContent = "Signing…";
      await save({
        goal: goalRaw
          ? {
              usdc: goalRaw,
              title: $<HTMLInputElement>("goal-title").value.trim() || "Stream goal",
              since: reset || !saved?.goal ? Math.floor(Date.now() / 1000) : saved.goal.since,
            }
          : null,
        shares: readShares(),
      });
      $<HTMLInputElement>("goal-reset").checked = false;
      $("saved").hidden = false;
    } catch (err) {
      $("save-error").textContent = err instanceof Error ? err.message : String(err);
      $("save-error").hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = "Save settings";
    }
  };

  render();
}

main().catch((e) => {
  $("page-error").textContent = e instanceof Error ? e.message : String(e);
  $("page-error").hidden = false;
});

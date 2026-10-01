// Watch page (/watch/<creator>): the creator's live stream from their platform, its chat, and
// Beam gifting on one link. Beam doesn't carry video; it embeds the platform's own player.
import { type CreatorConfig, type StreamLink, verifyCreatorConfig } from "@beam/shared";
import type { Hex } from "viem";
import { $, loadConfig, short } from "./pagekit.js";

const creator = location.pathname.split("/")[2] ?? "";
const host = location.hostname;

type Embed = { player: string | null; chat: string | null; page: string; label: string };

function embedsFor(s: StreamLink): Embed {
  const c = encodeURIComponent(s.channel);
  switch (s.platform) {
    case "twitch":
      return {
        player: `https://player.twitch.tv/?channel=${c}&parent=${host}&autoplay=true`,
        chat: `https://www.twitch.tv/embed/${c}/chat?parent=${host}&darkpopout`,
        page: `https://www.twitch.tv/${c}`,
        label: "on Twitch",
      };
    case "kick":
      // Kick's player embeds; its chat does not, so chat opens on Kick.
      return { player: `https://player.kick.com/${c}`, chat: null, page: `https://kick.com/${c}`, label: "on Kick" };
    case "youtube": {
      const isChannel = s.channel.startsWith("UC") && s.channel.length === 24;
      return isChannel
        ? {
            // A channel id plays whatever is live now; YouTube's chat needs a video id.
            player: `https://www.youtube.com/embed/live_stream?channel=${c}&autoplay=1`,
            chat: null,
            page: `https://www.youtube.com/channel/${c}/live`,
            label: "on YouTube",
          }
        : {
            player: `https://www.youtube.com/embed/${c}?autoplay=1`,
            chat: `https://www.youtube.com/live_chat?v=${c}&embed_domain=${host}`,
            page: `https://www.youtube.com/watch?v=${c}`,
            label: "on YouTube",
          };
    }
  }
}

function frame(src: string, title: string, allow = "autoplay; fullscreen; picture-in-picture"): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.src = src;
  f.title = title;
  f.allow = allow;
  f.allowFullscreen = true;
  return f;
}

async function main() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(creator)) throw new Error("This watch link is incomplete.");
  const { d } = await loadConfig();
  $<HTMLIFrameElement>("gift").src = `/g/${creator}?embed=1`;

  const settings = await fetch(`/api/creators/${creator}/config`)
    .then((r) => r.json() as Promise<{ config: CreatorConfig | null; signature: Hex | null }>)
    .catch(() => ({ config: null, signature: null }));
  const verified =
    settings.config && settings.signature && (await verifyCreatorConfig(d, settings.config, settings.signature)) ? settings.config : null;
  const name = verified?.displayName || short(creator);
  $("name").textContent = name;
  document.title = `${name} · Beam`;

  const stream = verified?.stream ?? null;
  if (!stream) {
    $("offline-text").textContent = `${name} hasn't linked a live stream yet. You can still send them a gift.`;
    $("offline").hidden = false;
    $("nochat").textContent = "No chat here yet.";
    $("nochat").hidden = false;
    return;
  }

  const e = embedsFor(stream);
  $("platform-badge").textContent = e.label;
  $("platform-badge").hidden = false;
  if (e.player) $("player").append(frame(e.player, `${name} live ${e.label}`));
  const external = $("external");
  external.innerHTML = "";
  const a = document.createElement("a");
  a.href = e.page;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `Open ${name} ${e.label} ↗`;
  external.append(a);
  external.hidden = false;

  if (e.chat) {
    const chat = $<HTMLIFrameElement>("chat");
    chat.src = e.chat;
    chat.hidden = false;
  } else {
    $("nochat").innerHTML = "";
    const link = document.createElement("a");
    link.href = e.page;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `Chat with ${name} ${e.label} ↗`;
    $("nochat").append(link);
    $("nochat").hidden = false;
  }
}

// Phone tabs: gifting and chat share the space under the video.
for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
  b.onclick = () => {
    for (const x of document.querySelectorAll<HTMLButtonElement>(".tabs button")) x.setAttribute("aria-selected", String(x === b));
    $("panel-gift").hidden = b.dataset.tab !== "gift";
    $("panel-chat").hidden = b.dataset.tab !== "chat";
  };
}
$("panel-chat").hidden = true;

main().catch((err) => {
  $("page-error").textContent = err instanceof Error ? err.message : String(err);
  $("page-error").hidden = false;
});

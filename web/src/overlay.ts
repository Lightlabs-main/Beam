import { parseUsdc, usdLabel } from "@beam/shared";
import confetti from "canvas-confetti";
import QRCode from "qrcode";

// Overlay URL: /overlay?creator=0x...&goal=100&since=<unix>&title=Stream%20goal&show=alert,qr,goal,recent
type Gift = {
  id: string;
  kind: "Direct" | "Split" | "Chatter" | "Bomb";
  from: string;
  channel: string;
  to: string | null;
  amount: string;
  displayName: string;
  message: string;
  actionCode: number;
  recipientLabel: string | null;
  slots: number | null;
  txHash: string;
};

const params = new URLSearchParams(location.search);
const creator = params.get("creator") ?? "";
const show = new Set((params.get("show") ?? "alert,qr,goal,recent,claims").split(",").map((s) => s.trim()));
const alertMs = Number(params.get("duration") ?? 6000);
const RECENT_ROWS = 5;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");

function setStatus(text: string | null) {
  status.hidden = !text;
  status.textContent = text ?? "";
}

const dollars = usdLabel;

const nameOf = (g: Gift) => g.displayName.trim() || `${g.from.slice(0, 6)}…${g.from.slice(-4)}`;

/** What the gifter did, as shown under their name. */
function verbOf(g: Gift): string {
  switch (g.kind) {
    case "Chatter":
      return `gifted ${g.recipientLabel?.trim() || "a chatter"} 🎁`;
    case "Bomb":
      return `dropped a Beam Bomb for ${g.slots ?? "?"} chatters 💣`;
    case "Split":
      return "gifted & shared it 🎉";
    default:
      return "gifted 🎉";
  }
}

/** Only money paid to this creator counts toward their goal; drops go to chatters. */
const paysCreator = (g: Gift) => g.to !== null && g.to.toLowerCase() === creator.toLowerCase();

// ---------------------------------------------------------------- alert queue

const queue: Gift[] = [];
let playing = false;
const confettiFire = confetti.create($<HTMLCanvasElement>("confetti"), { resize: true, useWorker: true });

async function playNext() {
  const gift = queue.shift();
  if (!gift) {
    playing = false;
    return;
  }
  playing = true;
  const el = $("alert");
  $("alert-amount").textContent = dollars(BigInt(gift.amount));
  $("alert-name").textContent = nameOf(gift);
  $("alert-verb").textContent = verbOf(gift);
  $("alert-message").textContent = gift.message;
  el.classList.remove("leaving");
  el.hidden = false;
  // Re-trigger the entrance animation for back-to-back gifts.
  void el.offsetWidth;

  const burst = (angle: number, x: number) =>
    confettiFire({ particleCount: 140, spread: 75, startVelocity: 55, angle, origin: { x, y: 0.75 }, ticks: 260 });
  burst(60, 0);
  burst(120, 1);
  setTimeout(() => confettiFire({ particleCount: 180, spread: 120, origin: { x: 0.5, y: 0.25 }, ticks: 240 }), 250);

  await new Promise((r) => setTimeout(r, alertMs));
  el.classList.add("leaving");
  await new Promise((r) => setTimeout(r, 380));
  el.hidden = true;
  void playNext();
}

function enqueueAlert(gift: Gift) {
  if (!show.has("alert")) return;
  queue.push(gift);
  if (!playing) void playNext();
}

// ---------------------------------------------------------------- claims

type Claim = { recipient: string; amount: string; kind: "Chatter" | "Bomb"; from: string; recipientLabel: string | null };

/** A banner when a chatter claims: proof on stream that someone with no wallet got paid. */
function showClaim(c: Claim) {
  if (!show.has("claims")) return;
  const li = document.createElement("li");
  const who = c.kind === "Chatter" && c.recipientLabel ? c.recipientLabel : `${c.recipient.slice(0, 6)}…${c.recipient.slice(-4)}`;
  const amt = document.createElement("span");
  amt.className = "amt";
  amt.textContent = dollars(BigInt(c.amount));
  li.append(
    document.createTextNode(c.kind === "Bomb" ? `💣 ${who} grabbed ` : `🎁 ${who} claimed `),
    amt,
    document.createTextNode(c.kind === "Bomb" ? ` from ${c.from || "the"} Beam Bomb` : ` from ${c.from || "a viewer"}`),
  );
  const list = $("toasts");
  list.prepend(li);
  while (list.children.length > 4) list.lastElementChild?.remove();
  setTimeout(() => {
    li.classList.add("leaving");
    setTimeout(() => li.remove(), 380);
  }, 8000);
}

// ---------------------------------------------------------------- recent + goal

const recent = $<HTMLOListElement>("recent");

function recentRow(g: Gift): HTMLLIElement {
  const li = document.createElement("li");
  const who = document.createElement("span");
  who.className = "who";
  who.textContent =
    g.kind === "Chatter" ? `${nameOf(g)} → ${g.recipientLabel?.trim() || "chatter"}` : g.kind === "Bomb" ? `${nameOf(g)} 💣` : nameOf(g);
  const amt = document.createElement("span");
  amt.className = "amt";
  amt.textContent = dollars(BigInt(g.amount));
  li.append(who, amt);
  return li;
}

function renderRecent(gifts: Gift[]) {
  recent.replaceChildren(...gifts.slice(0, RECENT_ROWS).map(recentRow));
  recent.hidden = !show.has("recent") || gifts.length === 0;
}

function pushRecent(g: Gift) {
  if (!show.has("recent")) return;
  recent.prepend(recentRow(g));
  while (recent.children.length > RECENT_ROWS) recent.lastElementChild?.remove();
  recent.hidden = false;
}

// Goal: from the URL when given, otherwise from the creator's signed settings (set on /creator).
let goalTarget = params.get("goal") ? parseUsdc(params.get("goal")!) : null;
let goalSince = params.get("since");
let goalTitle = params.get("title") ?? "Goal";

async function goalFromSettings() {
  if (goalTarget !== null) return;
  const { config } = await api<{ config: { goal: { usdc: string; title: string; since: number } | null } | null }>(
    `/api/creators/${creator}/config`,
  );
  if (!config?.goal) return;
  goalTarget = parseUsdc(config.goal.usdc);
  goalSince = String(config.goal.since);
  goalTitle = config.goal.title;
}
let goalNow = 0n;

function renderGoal() {
  if (goalTarget === null || !show.has("goal")) return;
  $("goal").hidden = false;
  $("goal-title").textContent = goalTitle;
  $("goal-now").textContent = dollars(goalNow);
  $("goal-target").textContent = dollars(goalTarget);
  const pct = goalTarget === 0n ? 100 : Number((goalNow * 10_000n) / goalTarget) / 100;
  $("goal-fill").style.width = `${Math.min(pct, 100)}%`;
}

// ---------------------------------------------------------------- data

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Loads the current state from indexed data. Runs at start and after every reconnect. */
async function sync() {
  const { gifts } = await api<{ gifts: Gift[] }>(`/api/creators/${creator}/gifts?limit=${RECENT_ROWS}`);
  renderRecent(gifts);
  if (goalTarget !== null && goalSince) {
    const { total } = await api<{ total: string }>(`/api/creators/${creator}/total?since=${goalSince}`);
    goalNow = BigInt(total);
    renderGoal();
  }
}

function connect(attempt = 0) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?creator=${creator}`);
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;

  ws.onopen = () => {
    attempt = 0;
    setStatus(null);
    // Catch up on anything indexed while disconnected (shown in the feed, not re-alerted).
    sync().catch((e) => console.error(e));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; gift?: Gift; claim?: Claim };
    if (msg.type === "claim" && msg.claim) return showClaim(msg.claim);
    if (msg.type !== "gift" || !msg.gift) return;
    const gift = msg.gift;
    enqueueAlert(gift);
    pushRecent(gift);
    if (goalTarget !== null && paysCreator(gift)) {
      goalNow += BigInt(gift.amount);
      renderGoal();
    }
  };
  ws.onclose = () => {
    offlineTimer = setTimeout(() => setStatus("Beam offline · reconnecting"), 3000);
    const delay = Math.min(1000 * 2 ** attempt, 15_000);
    setTimeout(() => {
      clearTimeout(offlineTimer);
      connect(attempt + 1);
    }, delay);
  };
}

async function main() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(creator)) {
    setStatus("Beam: add ?creator=0x… to this overlay URL");
    return;
  }
  await goalFromSettings().catch((e) => console.error(e));
  if (goalTarget !== null && !goalSince) setStatus("Beam: a goal needs &since=<unix time> to count from");

  if (show.has("qr")) {
    const giftUrl = `${location.origin}/g/${creator}`;
    $("qr-code").innerHTML = await QRCode.toString(giftUrl, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0e0c1c", light: "#ffffff" },
    });
    $("qr").hidden = false;
  }
  renderGoal();
  await sync().catch((e) => console.error(e));
  connect();
}

void main();

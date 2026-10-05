// Landing page: nav, scroll reveals, and the looping gift demo in the hero.
import QRCode from "qrcode";

document.documentElement.classList.add("js");
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Nav: solid background once scrolled, mobile drawer.
const nav = $("nav");
const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

const menu = $("menu");
const drawer = $("drawer");
const setMenu = (open: boolean) => {
  menu.setAttribute("aria-expanded", String(open));
  drawer.hidden = !open;
};
menu.addEventListener("click", () => setMenu(drawer.hidden));
drawer.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) setMenu(false);
});

// Reveal on scroll, with a small stagger inside each group.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
);
document.querySelectorAll<HTMLElement>(".reveal").forEach((el) => {
  const siblings = el.parentElement ? [...el.parentElement.children].filter((c) => c.classList.contains("reveal")) : [];
  el.style.setProperty("--d", `${Math.min(siblings.indexOf(el), 5) * 0.08}s`);
  io.observe(el);
});

// Bento hover light follows the pointer.
document.querySelectorAll<HTMLElement>(".tile").forEach((tile) => {
  tile.addEventListener("pointermove", (e) => {
    const r = tile.getBoundingClientRect();
    tile.style.setProperty("--mx", `${e.clientX - r.left}px`);
    tile.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
});

// A real QR in the demo overlay, pointing at this site.
const qr = QRCode.create(location.origin, { errorCorrectionLevel: "L" });
const n = qr.modules.size;
const svg = $("qr") as unknown as SVGSVGElement;
svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
let d = "";
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
svg.innerHTML = `<path d="${d}" fill="#0a0f1e"/>`;

// Hero demo: a gift lands every few seconds, the goal fills, the receipt updates.
const gifts = [
  { who: "ada_codes", amt: 5, msg: "clutch play 🔥" },
  { who: "kofi.eth", amt: 20, msg: "for the new mic 🎙️" },
  { who: "mira", amt: 1, msg: "gg" },
  { who: "zed_plays", amt: 10, msg: "that combo was insane" },
  { who: "lu", amt: 2.5, msg: "hi from Lagos 👋" },
];
const colors = ["#38e1ff", "#2e5bff", "#d946ef", "#eef2ff", "#34d399"];
const alert = $("alert");
const burst = alert.querySelector<HTMLElement>(".alert-burst")!;
for (let i = 0; i < 14; i++) {
  const s = document.createElement("i");
  const a = (i / 14) * Math.PI * 2;
  const r = 40 + Math.random() * 50;
  s.style.cssText = `background:${colors[i % colors.length]};--x:${Math.cos(a) * r}px;--y:${Math.sin(a) * r}px;--r:${Math.random() * 360}deg`;
  burst.append(s);
}

let goal = 62;
let i = 0;
const hex = () => Array.from({ length: 4 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

function fire() {
  const g = gifts[i++ % gifts.length]!;
  $("alert-who").textContent = g.who;
  $("alert-amt").textContent = `$${g.amt.toFixed(2)}`;
  $("alert-msg").textContent = g.msg;
  alert.classList.remove("show");
  void alert.offsetWidth;
  alert.classList.add("show");

  goal = goal + g.amt > 100 ? 18 : goal + g.amt;
  $("goal-amt").textContent = `$${Math.round(goal)}`;
  $("goal-bar").style.width = `${goal}%`;

  const receipt = $("receipt");
  receipt.classList.add("dim");
  setTimeout(() => {
    $("receipt-tx").textContent = `0x${hex()}…${hex()} · 0.${4 + Math.floor(Math.random() * 3)}${Math.floor(Math.random() * 10)}s`;
    receipt.classList.remove("dim");
  }, 250);

  const vc = $("viewer-count");
  vc.textContent = (1200 + Math.floor(Math.random() * 180)).toLocaleString("en-US");
}

if (reduced) {
  alert.style.opacity = "1";
  alert.style.transform = "translate(-50%, 0)";
} else {
  setTimeout(fire, 900);
  setInterval(() => !document.hidden && fire(), 4200);
}

// Network badge and footer status from the server, when it's reachable.
(async () => {
  try {
    const cfg = (await (await fetch("/api/config")).json()) as { network: "testnet" | "mainnet" };
    const net = $("net");
    net.textContent = cfg.network === "mainnet" ? "Monad mainnet" : "Monad testnet";
    net.hidden = false;
    $("eyebrow").textContent = cfg.network === "mainnet" ? "Live on Monad mainnet" : "Live on Monad testnet";
    $("status").textContent =
      cfg.network === "mainnet" ? "Running on Monad mainnet." : "This is the testnet build: gifts use free test USDC.";
  } catch {
    /* the landing page stands on its own without the API */
  }
})();

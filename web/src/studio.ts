import { downloadObsSetup } from "./obs.js";

// Beam Studio (/studio?creator=0x…): camera behind the live Beam overlay, recorded to a video file
// in the browser. The overlay is the same page OBS shows, so alerts fire from real on-chain gifts.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

function showError(message: string | null) {
  $("error").textContent = message ?? "";
  $("error").hidden = !message;
}

// ---- stage: keep the 1920×1080 overlay scaled to the 16:9 stage
const stage = $("stage");
const overlay = $<HTMLIFrameElement>("overlay");
const fit = () => (overlay.style.transform = `scale(${stage.clientWidth / 1920})`);
new ResizeObserver(fit).observe(stage);

// ---- creator
const creator = new URLSearchParams(location.search).get("creator") ?? "";
if (isAddress(creator)) {
  overlay.src = `/overlay?creator=${creator}`;
  $<HTMLAnchorElement>("earnings").href = `/earnings?creator=${creator}`;
  // The same overlay, set up in OBS from one file (Scene Collection → Import).
  $("obs").onclick = () => downloadObsSetup(`${location.origin}/overlay?creator=${creator}`);
  const giftUrl = `${location.origin}/g/${creator}`;
  $<HTMLInputElement>("gift-url").value = giftUrl;
  $("share").hidden = false;
  $("gift-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(giftUrl);
    } catch {
      $<HTMLInputElement>("gift-url").select();
      document.execCommand("copy");
    }
    $("gift-copy").textContent = "Copied";
    setTimeout(() => ($("gift-copy").textContent = "Copy gift link"), 1500);
  };
  $("buttons").hidden = false;
} else {
  $("setup").hidden = false;
  $("hint").hidden = true;
  $("go").onclick = () => {
    const a = $<HTMLInputElement>("creator").value.trim();
    if (!isAddress(a)) return showError("That isn't a wallet address (0x followed by 40 characters).");
    location.search = `?creator=${a}`;
  };
}

// ---- camera
let camera: MediaStream | null = null;
$("cam").onclick = async () => {
  showError(null);
  try {
    if (camera) {
      for (const t of camera.getTracks()) t.stop();
      camera = null;
      $<HTMLVideoElement>("camera").srcObject = null;
      $("placeholder").hidden = false;
      $("cam").textContent = "Turn on camera";
      return;
    }
    camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    $<HTMLVideoElement>("camera").srcObject = camera;
    $("placeholder").hidden = true;
    $("cam").textContent = "Turn off camera";
  } catch (e) {
    showError(`Camera: ${e instanceof Error ? e.message : String(e)}. Allow camera access in the address bar and try again.`);
  }
};

$("full").onclick = () => void document.documentElement.requestFullscreen?.().catch(() => {});
$("hide").onclick = () => document.body.classList.add("hide-controls");
$("show-controls").onclick = () => document.body.classList.remove("hide-controls");

// ---- recording: capture this tab (camera + overlay + confetti) and, optionally, the microphone
let recorder: MediaRecorder | null = null;

function pickMime(): { mime: string; ext: string } {
  for (const [mime, ext] of [
    ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"],
    ["video/webm", "webm"],
  ] as const) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: "", ext: "webm" };
}

function stop() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

$("rec").onclick = async () => {
  showError(null);
  if (!navigator.mediaDevices?.getDisplayMedia) return showError("Recording needs a desktop browser such as Chrome or Edge.");
  let screen: MediaStream;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
      // Chrome/Edge: offer this tab first, so the recording is exactly the stage.
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    } as DisplayMediaStreamOptions);
  } catch {
    return showError("Recording was cancelled. Press Record again and choose this tab.");
  }
  const tracks = [...screen.getVideoTracks()];
  let mic: MediaStream | null = null;
  if ($<HTMLInputElement>("mic").checked) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      tracks.push(...mic.getAudioTracks());
    } catch {
      showError("Microphone blocked, so recording without sound.");
    }
  }

  const { mime, ext } = pickMime();
  const chunks: Blob[] = [];
  recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    for (const t of [...screen.getTracks(), ...(mic?.getTracks() ?? [])]) t.stop();
    document.body.classList.remove("recording");
    const blob = new Blob(chunks, { type: recorder?.mimeType || `video/${ext}` });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `beam-recording-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    $("rec").textContent = "● Record";
    recorder = null;
  };
  // The browser's own "Stop sharing" button ends the recording too.
  screen.getVideoTracks()[0]?.addEventListener("ended", stop);
  recorder.start(1000);
  document.body.classList.add("recording");
};

addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "h" && !(e.target instanceof HTMLInputElement)) document.body.classList.toggle("hide-controls");
  if (e.key.toLowerCase() === "s" && recorder) stop();
  if (e.key === "Escape" && document.body.classList.contains("recording")) stop();
});

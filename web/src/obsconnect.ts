// The "Connect OBS" panel: one click adds the overlay to OBS's live scene over obs-websocket.
// Asks for OBS's WebSocket password only if OBS wants one, and explains how to switch the server on
// only if OBS can't be reached. A draggable link covers browsers that can't talk to OBS.
import "./obsconnect.css";
import { ObsError, addOverlayToObs, obsDropUrl } from "./obs.js";

export function mountObsConnect(box: HTMLElement, overlayUrl: string, onDone?: (scene: string) => void) {
  box.classList.add("obs-connect");
  box.innerHTML = `
    <button type="button" class="obs-go">⚡ Connect OBS in one click</button>
    <p class="obs-hint">Open OBS on this computer first.</p>
    <div class="obs-help" hidden>
      <p><b>Switch on OBS's connection</b> (once, takes 10 seconds):</p>
      <ol>
        <li>In OBS, open <b>Tools</b> → <b>WebSocket Server Settings</b>.</li>
        <li>Tick <b>Enable WebSocket server</b>, then click <b>Apply</b>.</li>
        <li>Come back here and click the button again.</li>
      </ol>
      <p class="obs-note">If your browser asks to reach devices on this computer or network, click <b>Allow</b>.</p>
    </div>
    <div class="obs-pass" hidden>
      <label>OBS WebSocket password</label>
      <p class="obs-note">In OBS: <b>Tools</b> → <b>WebSocket Server Settings</b> → <b>Show Connect Info</b> → copy <b>Server Password</b>.</p>
      <input type="password" autocomplete="off" spellcheck="false" placeholder="Paste it here" />
    </div>
    <p class="obs-msg" role="status" hidden></p>
    <p class="obs-or">Or drag this link onto the OBS preview:
      <a class="obs-drag" draggable="true" title="Drag me into OBS">⠿ Beam overlay</a></p>`;

  const go = box.querySelector<HTMLButtonElement>(".obs-go")!;
  const help = box.querySelector<HTMLElement>(".obs-help")!;
  const pass = box.querySelector<HTMLElement>(".obs-pass")!;
  const input = pass.querySelector("input")!;
  const msg = box.querySelector<HTMLElement>(".obs-msg")!;
  const drag = box.querySelector<HTMLAnchorElement>(".obs-drag")!;

  const say = (text: string, ok = false) => {
    msg.textContent = text;
    msg.classList.toggle("ok", ok);
    msg.hidden = false;
  };

  drag.href = obsDropUrl(overlayUrl);
  // It's for dragging; a click would just open the overlay in this tab.
  drag.onclick = (e) => {
    e.preventDefault();
    say("Drag it, don't click it: hold the link and drop it onto the big preview in OBS.");
  };

  const connect = async () => {
    go.disabled = true;
    go.textContent = "Connecting to OBS…";
    msg.hidden = true;
    try {
      const scene = await addOverlayToObs(overlayUrl, input.value.trim());
      help.hidden = true;
      pass.hidden = true;
      say(`✓ Beam is on your "${scene}" scene in OBS, on top and locked in place.`, true);
      go.textContent = "✓ Connected. Click to redo";
      onDone?.(scene);
    } catch (e) {
      const err = e instanceof ObsError ? e : new ObsError("other", e instanceof Error ? e.message : String(e));
      help.hidden = err.reason !== "unreachable";
      pass.hidden = err.reason !== "password" && pass.hidden;
      say(err.reason === "unreachable" ? "Couldn't reach OBS. Is it open, with its connection switched on?" : err.message);
      if (err.reason === "password") input.focus();
      go.textContent = "⚡ Connect OBS in one click";
    } finally {
      go.disabled = false;
    }
  };
  go.onclick = () => void connect();
  input.onkeydown = (e) => {
    if (e.key === "Enter") void connect();
  };
}

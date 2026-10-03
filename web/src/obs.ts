// A ready-made OBS scene collection: one "Beam" scene with the creator's camera filling the
// 1920×1080 canvas and their Beam overlay on top. Imported in OBS via Scene Collection → Import.
// Field layout follows OBS 32's own saved scene collections.

const PREV_VER = 537001986; // OBS 32.0
/** OBS's fixed id for the main canvas ("libobs-main"). */
const MAIN_CANVAS = "6c69626f-6273-4c00-9d88-c5136d61696e";
// OBS 31+ also stores positions relative to the canvas: from its centre, in half-heights.
const rel = (x: number, y: number) => ({ x: (x - 960) / 540, y: (y - 540) / 540 });
const relSize = (x: number, y: number) => ({ x: x / 540, y: y / 540 });

function source(id: string, name: string, settings: Record<string, unknown>, uuid: string, mixers = 255) {
  return {
    prev_ver: PREV_VER,
    name,
    uuid,
    id,
    versioned_id: id,
    settings,
    mixers,
    sync: 0,
    flags: 0,
    volume: 1,
    balance: 0.5,
    enabled: true,
    muted: false,
    "push-to-mute": false,
    "push-to-mute-delay": 0,
    "push-to-talk": false,
    "push-to-talk-delay": 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {},
  };
}

function item(name: string, uuid: string, id: number, fill: boolean) {
  return {
    name,
    source_uuid: uuid,
    visible: true,
    locked: !fill, // the overlay sits exactly on the canvas; lock it so it isn't nudged by accident
    rot: 0,
    scale_ref: { x: 1920, y: 1080 },
    align: 5,
    // Camera: scale to cover the whole canvas, cropping the edges if its shape differs.
    bounds_type: fill ? 3 : 0,
    bounds_align: 0,
    bounds_crop: fill,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id,
    group_item_backup: false,
    pos: { x: 0, y: 0 },
    pos_rel: rel(0, 0),
    scale: { x: 1, y: 1 },
    scale_rel: { x: 1, y: 1 },
    bounds: fill ? { x: 1920, y: 1080 } : { x: 0, y: 0 },
    bounds_rel: fill ? relSize(1920, 1080) : { x: 0, y: 0 },
    scale_filter: "disable",
    blend_method: "default",
    blend_type: "normal",
    show_transition: { duration: 0 },
    hide_transition: { duration: 0 },
    private_settings: {},
  };
}

/** Source types OBS uses on this operating system: camera, desktop audio, microphone. */
function platformSources(): { camera: string; desktop: string | null; mic: string } {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return { camera: "av_capture_input_v2", desktop: null, mic: "coreaudio_input_capture" };
  if (/Linux/.test(ua) && !/Android/.test(ua)) return { camera: "v4l2_input", desktop: "pulse_output_capture", mic: "pulse_input_capture" };
  return { camera: "dshow_input", desktop: "wasapi_output_capture", mic: "wasapi_input_capture" };
}

export function obsSceneCollection(overlayUrl: string, collectionName = "Beam"): string {
  const camera = crypto.randomUUID();
  const overlay = crypto.randomUUID();
  const scene = crypto.randomUUID();
  const os = platformSources();
  const sources = [
    source(os.camera, "Camera", {}, camera),
    source("browser_source", "Beam overlay", { url: overlayUrl, width: 1920, height: 1080, reroute_audio: false }, overlay),
    // Scene items are listed bottom to top: camera first, overlay drawn over it.
    { ...source("scene", "Beam", { id_counter: 2, custom_size: false, items: [item("Camera", camera, 1, true), item("Beam overlay", overlay, 2, false)] }, scene, 0), canvas_uuid: MAIN_CANVAS },
  ];
  // Without these, an imported collection would stream with no sound.
  const audio = {
    ...(os.desktop ? { DesktopAudioDevice1: source(os.desktop, "Desktop Audio", { device_id: "default" }, crypto.randomUUID()) } : {}),
    AuxAudioDevice1: source(os.mic, "Mic/Aux", { device_id: "default" }, crypto.randomUUID()),
  };
  return JSON.stringify(
    {
      name: collectionName,
      ...audio,
      sources,
      groups: [],
      scene_order: [{ name: "Beam" }],
      current_scene: "Beam",
      current_program_scene: "Beam",
      canvases: [],
      current_transition: "Fade",
      transition_duration: 300,
      transitions: [],
      quick_transitions: [],
      saved_projectors: [],
      preview_locked: false,
      scaling_enabled: false,
      scaling_level: 0,
      scaling_off_x: 0,
      scaling_off_y: 0,
      resolution: { x: 1920, y: 1080 },
      version: 2,
    },
    null,
    2,
  );
}

export function downloadObsSetup(overlayUrl: string) {
  const blob = new Blob([obsSceneCollection(overlayUrl)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "Beam-OBS-setup.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// ------------------------------------------------------------------ one click: OBS's own WebSocket
// OBS 28+ ships obs-websocket (protocol v5). The page talks to it on this computer and adds the
// overlay to whatever scene is live, so a streamer keeps their own scenes.

export const OBS_PORT = 4455;
export const OVERLAY_NAME = "Beam overlay";

/** Why connecting failed, in words a streamer can act on. */
export class ObsError extends Error {
  constructor(
    readonly reason: "unreachable" | "blocked" | "password" | "other",
    message: string,
  ) {
    super(message);
  }
}

type Status = { result: boolean; code: number; comment?: string };
type Response = { requestId: string; requestStatus: Status; responseData?: Record<string, unknown> };

const sha256b64 = async (s: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))));

class ObsSocket {
  private pending = new Map<string, (r: Response) => void>();
  private next = 0;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as { op: number; d: Response };
      if (m.op === 7) this.pending.get(m.d.requestId)?.(m.d);
    });
  }

  /** Opens and identifies; `password` is only needed when OBS has authentication on. */
  static open(password: string, port = OBS_PORT): Promise<ObsSocket> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
      } catch {
        // Safari refuses ws:// from an https page outright.
        return reject(new ObsError("blocked", "This browser won't let a web page talk to OBS. Use Chrome, Edge or Firefox, or the setup file below."));
      }
      let identified = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new ObsError("unreachable", "OBS didn't answer."));
      }, 8000);
      ws.addEventListener("message", async (e) => {
        const m = JSON.parse(String(e.data)) as { op: number; d: { authentication?: { challenge: string; salt: string } } };
        if (m.op === 0) {
          const a = m.d.authentication;
          if (a && !password) {
            clearTimeout(timer);
            ws.close();
            return reject(new ObsError("password", "OBS needs its WebSocket password."));
          }
          const authentication = a ? await sha256b64((await sha256b64(password + a.salt)) + a.challenge) : undefined;
          ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication, eventSubscriptions: 0 } }));
        } else if (m.op === 2) {
          identified = true;
          clearTimeout(timer);
          resolve(new ObsSocket(ws));
        }
      });
      ws.addEventListener("close", (e) => {
        clearTimeout(timer);
        if (identified) return;
        if (e.code === 4009) reject(new ObsError("password", "That password didn't work. Copy it again from OBS."));
        else reject(new ObsError("unreachable", "Couldn't reach OBS on this computer."));
      });
    });
  }

  async call<T = Record<string, unknown>>(requestType: string, requestData: Record<string, unknown> = {}): Promise<T> {
    const r = await this.callRaw(requestType, requestData);
    if (!r.requestStatus.result) throw new ObsError("other", `OBS said: ${r.requestStatus.comment ?? requestType} (${r.requestStatus.code})`);
    return (r.responseData ?? {}) as T;
  }

  callRaw(requestType: string, requestData: Record<string, unknown> = {}): Promise<Response> {
    const requestId = String(++this.next);
    return new Promise((resolve) => {
      this.pending.set(requestId, (r) => {
        this.pending.delete(requestId);
        resolve(r);
      });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() {
    this.ws.close();
  }
}

const NOT_FOUND = 600;
const ALREADY_EXISTS = 601;

/**
 * Puts the Beam overlay on top of OBS's live scene, scaled to the canvas and locked. Running it
 * again updates the existing "Beam overlay" source rather than adding a second one.
 * Returns the scene's name.
 */
export async function addOverlayToObs(overlayUrl: string, password: string, port = OBS_PORT): Promise<string> {
  const obs = await ObsSocket.open(password, port);
  try {
    const live = await obs.call<{ currentProgramSceneName?: string; sceneName?: string }>("GetCurrentProgramScene");
    const sceneName = live.sceneName ?? live.currentProgramSceneName!;
    const inputSettings = { url: overlayUrl, width: 1920, height: 1080, reroute_audio: false };

    const created = await obs.callRaw("CreateInput", { sceneName, inputName: OVERLAY_NAME, inputKind: "browser_source", inputSettings, sceneItemEnabled: true });
    let sceneItemId: number;
    if (created.requestStatus.result) {
      sceneItemId = created.responseData!.sceneItemId as number;
    } else if (created.requestStatus.code === ALREADY_EXISTS) {
      // Set up before (this button or the setup file): point it at this overlay and make sure it's in the live scene.
      const { inputKind } = await obs.call<{ inputKind: string }>("GetInputSettings", { inputName: OVERLAY_NAME });
      if (inputKind !== "browser_source") throw new ObsError("other", `OBS already has a source called "${OVERLAY_NAME}" that isn't a browser source. Rename it and try again.`);
      await obs.call("SetInputSettings", { inputName: OVERLAY_NAME, inputSettings, overlay: true });
      const found = await obs.callRaw("GetSceneItemId", { sceneName, sourceName: OVERLAY_NAME });
      if (found.requestStatus.result) sceneItemId = found.responseData!.sceneItemId as number;
      else if (found.requestStatus.code === NOT_FOUND) sceneItemId = (await obs.call<{ sceneItemId: number }>("CreateSceneItem", { sceneName, sourceName: OVERLAY_NAME })).sceneItemId;
      else throw new ObsError("other", `OBS said: ${found.requestStatus.comment ?? "GetSceneItemId"}`);
      await obs.call("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: true });
    } else {
      throw new ObsError("other", `OBS said: ${created.requestStatus.comment ?? "CreateInput"} (${created.requestStatus.code})`);
    }

    // On top of everything, filling the canvas whatever its size or shape, and locked in place.
    const { sceneItems } = await obs.call<{ sceneItems: unknown[] }>("GetSceneItemList", { sceneName });
    await obs.call("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: sceneItems.length - 1 });
    const { baseWidth, baseHeight } = await obs.call<{ baseWidth: number; baseHeight: number }>("GetVideoSettings");
    await obs.call("SetSceneItemLocked", { sceneName, sceneItemId, sceneItemLocked: false });
    await obs.call("SetSceneItemTransform", {
      sceneName,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        rotation: 0,
        alignment: 5,
        boundsType: "OBS_BOUNDS_SCALE_INNER",
        boundsAlignment: 0,
        boundsWidth: baseWidth,
        boundsHeight: baseHeight,
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0,
      },
    });
    await obs.call("SetSceneItemLocked", { sceneName, sceneItemId, sceneItemLocked: true });
    return sceneName;
  } finally {
    obs.close();
  }
}

/**
 * The overlay link to drag straight onto OBS's preview: OBS turns a dropped link into a browser
 * source sized to the canvas and named by `layer-name`. OBS removes the layer-* parameters; the
 * overlay ignores them anyway.
 */
export function obsDropUrl(overlayUrl: string): string {
  const u = new URL(overlayUrl);
  u.searchParams.set("layer-name", OVERLAY_NAME);
  return u.toString();
}

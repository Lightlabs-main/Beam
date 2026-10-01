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

import hashlib
import json
import re
import uuid

FPS = 24
MAX_FRAMES = 362
ID = re.compile(r"[a-f0-9]{32}")
TOKEN = re.compile(r"[a-f0-9]{64}")
ASSET = re.compile(r"[a-f0-9]{32}\.(?:png|jpg|webp)")
VIDEO_ASSET = re.compile(r"[a-f0-9]{32}\.(?:mp4|mov|mkv|webm)")
AUDIO_ASSET = re.compile(r"[a-f0-9]{32}\.(?:wav|mp3|flac|m4a|ogg)")
KEYFRAMES = {"T2VA": (), "I2VA": ("first",), "FL2VA": ("first", "last"), "L2VA": ("last",)}
GENERATION_MODES = ("legacy", *KEYFRAMES, "REF")
MEDIA_FIELDS = ("first_frame", "last_frame", "references", "videos", "audios", "ref_image_size")
DEFAULTS = {
    "width": 640, "height": 640, "frames": 124, "seed": "420030", "steps": 8,
    "cfg": 1.0, "sampler": "lcm", "scheduler": "simple", "shift_video": 10.0,
    "shift_audio": 3.0, "denoise": 1.0, "speed_mode": "automatic", "stages": 4,
    "noise_policy": "direct_coarse", "delta": 0.075, "amplitude": 21.5819,
    "exponent": 0.9276, "seed_offset": 10000, "ratio_mode": "steps",
    "transitions": [[3, 0.25], [4, 0.5], [5, 0.75], [8, 1.0]],
    "trim_overlap": True,
}
DELIVERY = {"fps": 24, "rife": False, "rtx_scale": 1.0, "rtx_quality": "ULTRA"}
LIVE_PREVIEW = {"enabled": False, "resolution": 256, "jpeg_quality": 75, "frames": 4, "fps": 8}
LIVE_PREVIEW_LIMITS = {"resolution": (96, 768), "jpeg_quality": (20, 95), "frames": (1, 12), "fps": (1, 30)}


def digest(value):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def identifier(value, label):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError(f"{label} must be a 32-digit hexadecimal ID")
    return value


def text(value, label, limit=40000):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{label} must be text with at most {limit} characters")
    return value


def number(value, low, high, label, integer=False):
    if type(value) not in (int, float) or not low <= value <= high or (integer and type(value) is not int):
        raise ValueError(f"{label} must be {'a whole number' if integer else 'a number'} from {low} to {high}")
    return value


def choice(value, choices, label):
    if value not in choices:
        raise ValueError(f"{label} must be one of {', '.join(map(str, choices))}")
    return value


def boolean(value, label):
    if type(value) is not bool:
        raise ValueError(f"{label} must be true or false")
    return value


def fields(value, allowed, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    unexpected = value.keys() - set(allowed)
    if unexpected:
        raise ValueError(f"{label} contains unknown fields: {', '.join(sorted(unexpected))}")
    return value


def aligned_frames(frames):
    return 5 + ((frames - 5 + 16) // 17) * 17


def validate_settings(settings):
    checked = settings.copy()
    for k in ("width", "height"):
        number(checked[k], 64, 2048, k, integer=True)
        if checked[k] % 32:
            raise ValueError(f"{k} must be divisible by 32")
    checked["frames"] = aligned_frames(number(checked["frames"], 5, MAX_FRAMES, "frames", integer=True))
    seed = checked["seed"]
    if type(seed) is int:
        seed = str(seed)
    if not isinstance(seed, str) or not re.fullmatch(r"[0-9]{1,20}", seed) or int(seed) > 2**64 - 1:
        raise ValueError("seed must be a decimal integer from 0 to 18446744073709551615")
    checked["seed"] = str(int(seed))
    number(checked["steps"], 2, 200, "steps", integer=True)
    number(checked["stages"], 2, 4, "stages", integer=True)
    number(checked["cfg"], 1, 30, "CFG")
    number(checked["shift_video"], 0.01, 100, "video shift")
    number(checked["shift_audio"], 0.01, 100, "audio shift")
    number(checked["denoise"], 0.05, 1, "denoise")
    number(checked["delta"], 0.0001, 0.5, "SPEED tolerance")
    number(checked["amplitude"], 0.0001, 1e6, "SPEED amplitude")
    number(checked["exponent"], 0.0001, 10, "SPEED exponent")
    number(checked["seed_offset"], 0, 2**31 - 1, "SPEED seed offset", integer=True)
    choice(checked["speed_mode"], ("automatic", "manual"), "SPEED mode")
    choice(checked["noise_policy"], ("direct_coarse", "coupled_full_grid"), "SPEED noise policy")
    choice(checked["ratio_mode"], ("steps", "ratio"), "manual stage units")
    boolean(checked["trim_overlap"], "trim overlap")
    for k in ("scheduler", "sampler"):
        text(checked[k], k, 80)
    transitions = checked["transitions"]
    if not isinstance(transitions, list) or not 2 <= len(transitions) <= 4:
        raise ValueError("A manual SPEED schedule needs 2 to 4 stage pairs")
    for pair in transitions:
        if not isinstance(pair, list) or len(pair) != 2:
            raise ValueError("Each manual SPEED stage must be [goal, resolution]")
        number(pair[0], 0, 1000 if checked["ratio_mode"] == "steps" else 1, "stage goal")
        number(pair[1], 0, 1, "stage resolution")
    return checked


def asset_id(value, pattern, label):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"Import {label} into the Director library before using it")
    return value


def validate_media(raw):
    checked = fields(raw, MEDIA_FIELDS, "Reference media").copy()
    for key in ("first_frame", "last_frame"):
        if checked.get(key) is not None:
            asset_id(checked[key], ASSET, "the reference image")
    for key, pattern, label in (("references", ASSET, "the reference image"), ("audios", AUDIO_ASSET, "the reference audio")):
        if key in checked:
            if not isinstance(checked[key], list):
                raise ValueError(f"{key} must be a list")
            checked[key] = [asset_id(value, pattern, label) for value in checked[key]]
    if "videos" in checked:
        if not isinstance(checked["videos"], list):
            raise ValueError("videos must be a list")
        videos = []
        for video in checked["videos"]:
            fields(video, ("asset", "audio_mode"), "Reference video")
            videos.append({
                "asset": asset_id(video.get("asset"), VIDEO_ASSET, "the reference video"),
                "audio_mode": choice(video.get("audio_mode", "paired"), ("paired", "off", "standalone"), "Video soundtrack"),
            })
        checked["videos"] = videos
    if "ref_image_size" in checked:
        choice(checked["ref_image_size"], ("match", "max"), "Reference image size")
    return checked


def validate_project(project):
    fields(project, ("version", "id", "name", "character", "environment", "style", "settings", "delivery", "live_preview", "auto_cleanup", "scenes", "speakers"), "Project")
    if type(project.get("version")) is not int or project["version"] != 1:
        raise ValueError("Project version must be 1")
    identifier(project.get("id"), "Project ID")
    text(project.get("name", ""), "Project name", 120)
    for key in ("character", "environment", "style"):
        text(project.get(key, ""), key)
    speakers = project.get("speakers", {})
    if not isinstance(speakers, dict) or any(not re.fullmatch(r"S[1-9][0-9]*", key) for key in speakers):
        raise ValueError("Speaker IDs must have the form S1 or S2")
    for name in speakers.values():
        text(name, "Speaker name", 120)
    settings = validate_settings(DEFAULTS | fields(project.get("settings", {}), DEFAULTS, "Project settings"))
    delivery = DELIVERY | fields(project.get("delivery", {}), DELIVERY, "Delivery")
    number(delivery["fps"], 24, 120, "Delivery FPS", integer=True)
    choice(delivery["fps"], (24, 48, 72, 96, 120), "Delivery FPS")
    boolean(delivery["rife"], "RIFE")
    if delivery["rife"] and delivery["fps"] == FPS:
        raise ValueError("Set delivery FPS above 24 to use RIFE")
    number(delivery["rtx_scale"], 1, 4, "RTX scale")
    choice(delivery["rtx_quality"], ("LOW", "MEDIUM", "HIGH", "ULTRA"), "RTX quality")
    auto_cleanup = boolean(project.get("auto_cleanup", True), "Auto memory cleanup")
    preview = LIVE_PREVIEW | fields(project.get("live_preview", {}), LIVE_PREVIEW, "Live preview")
    boolean(preview["enabled"], "Live preview")
    for key, (minimum, maximum) in LIVE_PREVIEW_LIMITS.items():
        number(preview[key], minimum, maximum, f"Live preview {key.replace('_', ' ')}", integer=True)
    scenes = project.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("Add at least one scene")
    scene_ids = set()
    checked_scenes = []
    for index, scene in enumerate(scenes):
        fields(scene, ("id", "title", "transition", "previous_reference", "overrides", "passes", "generation", *MEDIA_FIELDS), "Scene")
        scene_id = identifier(scene.get("id"), "Scene ID")
        if scene_id in scene_ids:
            raise ValueError("Scene IDs must be unique")
        scene_ids.add(scene_id)
        title = text(scene.get("title", ""), "Scene title", 120) or f"Scene {index + 1}"
        transition = choice(scene.get("transition", "cut"), ("cut", "continuous", "reference"), "Transition")
        previous = boolean(scene.get("previous_reference", False), "Previous reference")
        scene_generation = choice(scene.get("generation", "legacy"), GENERATION_MODES, "Scene generation mode")
        checked_media = validate_media({k: scene[k] for k in MEDIA_FIELDS if k in scene})
        refs = checked_media.get("references", [])
        if index == 0 and (transition == "continuous" or (transition == "reference" and previous)):
            raise ValueError("The first scene has no previous scene")
        if len(refs) + (scene_generation == "legacy" and transition == "reference" and previous) > 9:
            raise ValueError("H3 supports at most nine reference images")
        scene_settings = validate_settings(settings | fields(scene.get("overrides", {}), DEFAULTS, f"{title} overrides"))
        raw_passes = scene.get("passes")
        if not isinstance(raw_passes, list) or not raw_passes:
            raise ValueError(f"{title} needs at least one pass")
        pass_ids = set()
        passes = []
        for pass_index, entry in enumerate(raw_passes):
            fields(entry, ("id", "mode", "prompt", "negative", "overrides", "generation", "builder", "compiled_prompt", "media"), f"{title} pass")
            pass_id = identifier(entry.get("id"), "Pass ID")
            if pass_id in pass_ids:
                raise ValueError("Pass IDs must be unique within a scene")
            pass_ids.add(pass_id)
            mode = choice(entry.get("mode", "generate" if pass_index == 0 else "extend"),
                          ("generate",) if pass_index == 0 else ("extend", "replace"), "Pass mode")
            generation = choice(entry.get("generation", scene_generation), GENERATION_MODES, "Pass generation mode")
            if generation == "legacy" and pass_index == 0:
                if transition == "reference" and not (refs or previous):
                    raise ValueError(f"{title} needs an image reference")
                if transition == "continuous" and scene.get("first_frame"):
                    raise ValueError(f"{title} already gets its first frame from the previous scene")
            prompt = text(entry.get("prompt", ""), "Pass prompt")
            if generation != "legacy":
                prompt = text(entry.get("compiled_prompt", ""), "Compiled Fantastic prompt")
            negative = text(entry.get("negative", ""), "Negative prompt")
            effective = validate_settings(scene_settings | fields(entry.get("overrides", {}), DEFAULTS, "Pass overrides"))
            media = validate_media(entry.get("media", {}))
            builder = entry.get("builder")
            if builder is not None and not isinstance(builder, dict):
                raise ValueError("Fantastic prompt state must be an object")
            if "seed" in entry.get("overrides", {}) or "seed" in scene.get("overrides", {}):
                base = int(effective["seed"])
                seed = base if "seed" in entry.get("overrides", {}) else base + pass_index
            elif index == 0 and pass_index == 0:
                seed = int(settings["seed"])
            else:
                seed = int(digest([settings["seed"], scene_id, pass_id])[:16], 16)
            offset = effective["seed_offset"] + 4
            if effective["noise_policy"] == "direct_coarse" and seed > 2**64 - 1 - offset:
                if "seed" in entry.get("overrides", {}) or "seed" in scene.get("overrides", {}) or index == pass_index == 0:
                    raise ValueError("Seed plus the SPEED stage offset exceeds the uint64 range")
                seed %= 2**64 - offset
            elif seed > 2**64 - 1:
                raise ValueError("Derived pass seed exceeds the uint64 range")
            effective["seed"] = str(seed)
            passes.append({"id": pass_id, "mode": mode, "prompt": prompt, "negative": negative, "settings": effective,
                           "generation": generation, "media": media, "builder": builder})
        checked_scenes.append(scene | checked_media | {"title": title, "transition": transition, "previous_reference": previous,
                                                       "references": refs, "passes": passes})
    return project | {"settings": settings, "delivery": delivery, "live_preview": preview,
                      "auto_cleanup": auto_cleanup, "scenes": checked_scenes}


def default_project():
    return {
        "version": 1, "id": uuid.uuid4().hex, "name": "Untitled film",
        "character": "", "environment": "", "style": "", "settings": DEFAULTS.copy(),
        "delivery": DELIVERY.copy(), "live_preview": LIVE_PREVIEW.copy(), "auto_cleanup": True,
        "scenes": [{"id": uuid.uuid4().hex, "title": "Scene 1", "transition": "cut",
                    "passes": [{"id": uuid.uuid4().hex, "mode": "generate", "prompt": "", "overrides": {}}],
                    "overrides": {}, "references": []}],
    }


def parse_action(value, scene_ids):
    if not value:
        return None
    action = fields(json.loads(value), ("scene", "mode", "nonce"), "Render action")
    mode = choice(action.get("mode", "regenerate"), ("resume", "regenerate"), "Render action")
    if action.get("scene") not in scene_ids:
        raise ValueError("Regeneration scene is missing from this project")
    return action | {"nonce": identifier(action.get("nonce"), "Regeneration request ID") if mode == "regenerate" else None}

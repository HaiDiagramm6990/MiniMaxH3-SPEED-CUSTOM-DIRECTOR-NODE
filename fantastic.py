"""Bridge to the registered Fantastic builder and its installed composer."""

import hashlib
import inspect
import json
from pathlib import Path
from urllib.parse import quote

import nodes

from .project import FPS, GENERATION_MODES, KEYFRAMES

BUILDER = "MiniMaxH3PromptBuilder"
FRONTEND_EXPORTS = ("MODES", "MODE_CAPACITY", "TASK_TYPES", "VISUAL_MARKERS", "AUDIO_MARKERS",
                    "OPTIONAL_SECTIONS", "defaultState", "normaliseState", "generate", "validate",
                    "snapLength", "loadPrefs", "setNamePrefix")


def upstream():
    cls = nodes.NODE_CLASS_MAPPINGS.get(BUILDER)
    if cls is None:
        raise RuntimeError("Enable ComfyUI-Fantastic-MiniMaxH3-PromptBuilder to use Fantastic generation modes.")
    module = inspect.getmodule(cls)
    if module is None or set(getattr(module, "MODE_LIMITS", {})) != set(GENERATION_MODES[1:]):
        raise RuntimeError("The installed Fantastic package has a different generation-mode contract.")
    return cls, module


def compiler_source():
    _, module = upstream()
    package = Path(module.__file__).parent
    original = (package / "web" / "promptbuilder.js").read_text(encoding="utf-8")
    # shortcut: the installed composer has no module exports; use them directly if upstream adds them.
    footer = '\napp.registerExtension({\n  name: "MiniMaxH3.PromptBuilder",'
    body, found, _ = original.partition(footer)
    if not found or "app.registerExtension(" in body or not all(name in body for name in FRONTEND_EXPORTS):
        raise RuntimeError("The installed Fantastic composer no longer matches the Director bridge.")
    for filename in ("medialoader.js", "refmodstack.js"):
        body = body.replace(f'"./{filename}"', f'"../../extensions/{quote(package.name)}/{filename}"')
    return body + "\nexport { " + ", ".join(FRONTEND_EXPORTS) + " };\n"


def identity():
    _, module = upstream()
    path = Path(module.__file__).parent
    return [hashlib.sha256((path / file).read_bytes()).hexdigest()
            for file in ("nodes.py", "media_io.py", "web/promptbuilder.js")]


def gated(mode, prompt, bundle):
    cls, module = upstream()
    limits = module.MODE_LIMITS[mode]
    for group, key in (("picture", "pictures"), ("video", "videos"),
                       ("video_audio", "video_audios"), ("audio", "audios")):
        if len(bundle.get(key, ())) > limits[group]:
            raise ValueError(f"Fantastic {mode} accepts at most {limits[group]} {key.replace('_', ' ')}.")
    result = cls().build(prompt, json.dumps({"mode": mode}), references=bundle)
    return result[0], result[-2]


def media_for(scene, beat):
    names = ("first_frame", "last_frame", "references", "videos", "audios", "ref_image_size")
    defaults = {key: scene[key] for key in names if key in scene}
    if beat["mode"] == "extend":
        defaults.pop("first_frame", None)
    return defaults | beat.get("media", {})


def depends_on_previous(scene):
    beat = scene["passes"][0]
    mode = beat["generation"]
    transition = scene["transition"]
    if mode in ("REF", "legacy"):
        return transition == "continuous" or (transition == "reference" and scene["previous_reference"])
    return transition == "continuous" and "first" in KEYFRAMES[mode] and not media_for(scene, beat).get("first_frame")


def plan(scene, beat, has_graph_image):
    mode = beat["generation"]
    role = beat["mode"]
    media = media_for(scene, beat)
    cut = scene["transition"]
    start, end, previous = None, None, False
    if mode == "REF":
        pics = media.get("references", [])
        videos, audios = media.get("videos", []), media.get("audios", [])
        previous = role == "generate" and (cut == "continuous" or (cut == "reference" and scene["previous_reference"]))
        if not (pics or videos or audios or previous):
            raise ValueError("Reference mode needs an image, video, audio, or the preceding scene’s tail.")
        limits = upstream()[1].MODE_LIMITS[mode]
        if len(pics) + int(previous) > limits["picture"] or len(videos) > limits["video"] or len(audios) > limits["audio"]:
            raise ValueError("Reference media exceeds the installed Fantastic mode limits.")
        return {"pictures": pics, "videos": videos, "audios": audios, "previous": previous,
                "image_size": media.get("ref_image_size", "match")}
    required = KEYFRAMES[mode]
    if "first" in required:
        start = media.get("first_frame")
        if not start:
            if role == "replace":
                start = "pass-head"
            elif role == "extend":
                start = "pass-tail"
            elif cut == "continuous":
                start = "scene-tail"
            elif has_graph_image:
                start = "graph"
        if not start:
            raise ValueError(f"{mode} needs a first frame.")
    if "last" in required:
        end = media.get("last_frame") or ("pass-tail" if role == "replace" else None)
        if not end:
            raise ValueError(f"{mode} needs a last frame.")
    return {"first": start, "last": end}


def load_av(videos, audio_ids, count, width, height):
    _, module = upstream()
    media_io = module.media_io
    def path(asset_id):
        return f"h3_speed_director/{asset_id} [input]"
    # Only the portion the native H3 conditioner can use is decoded.
    limit = count / FPS
    clips, paired, standalone = [], [], []
    for video in videos:
        name = path(video["asset"])
        clip = media_io.load_video_frames(name, fps=FPS, max_frames=count, resize=max(width, height))
        if len(clip) < 5:
            raise ValueError("A Fantastic reference video needs at least five frames at 24 fps.")
        clips.append(clip)
        audio = media_io.extract_audio(name, end=min(limit, (5 + (len(clip) - 5) // 17 * 17) / FPS)) \
            if video["audio_mode"] != "off" and media_io.probe(name)["has_audio"] else None
        paired.append(audio if video["audio_mode"] == "paired" else None)
        if audio is not None and video["audio_mode"] == "standalone":
            standalone.append(audio)
    standalone.extend(media_io.load_audio(path(asset), end=limit) for asset in audio_ids)
    return {"videos": clips, "video_audios": paired, "audios": standalone}

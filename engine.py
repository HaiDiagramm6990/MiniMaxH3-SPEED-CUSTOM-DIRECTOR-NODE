from functools import cache
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time

import comfy.model_management
from comfy_api.latest._input_impl.video_types import VideoFromFile
from comfy_execution.graph_utils import is_link
from comfy_execution.utils import get_executing_context
import folder_paths
import nodes
from server import PromptServer

from . import fantastic
from .live_preview import LivePreview
from .media import concatenate, ffmpeg_path, finish_pass, read_frame, write_pass
from .native import NativeH3, check_delivery, interrupt
from .project import FPS, digest, parse_action, validate_project
from .storage import SESSION, asset_path, cleanup, output_root, pass_complete, project_root, read_json, staging, write_json


def source_digest():
    # Legacy render semantics and delivery are unchanged. Keep the released cache identity.
    return ["46cda5bbfd90313f714ec024838365dd13bd63973be4b9acb47ca466769a2535",
            "453b1067551a435da154399667563b2d91883836e85d858ca3f625bd59480c6d",
            "78267e6eb0e7d9a194b5f17cea7cdde100861145dceeb7e5ab8992e266b72ff4"]


def fingerprint(prompt, unique_id):
    folders = {"unet_name": "diffusion_models", "ckpt_name": "checkpoints", "clip_name": "text_encoders",
               "vae_name": "vae", "lora_name": "loras"}

    def file_identity(key, value):
        folder = folders.get(key) or ("loras" if key.startswith("lora_") else None)
        if folder and isinstance(value, str):
            location = folder_paths.get_full_path(folder, value)
            if location:
                path = Path(location)
                stat = path.stat()
                return [value, str(path.resolve()), stat.st_size, stat.st_mtime_ns]
        if isinstance(value, dict):
            return {child: file_identity(child, item) for child, item in value.items()}
        if isinstance(value, list):
            return [file_identity(key, item) for item in value]
        return value

    @cache
    def node_identity(node_id):
        entry = prompt[node_id]
        inputs = {k: resolve(k, v) for k, v in entry["inputs"].items()}
        return digest([entry["class_type"], inputs])

    def resolve(key, value):
        if is_link(value) and str(value[0]) in prompt:
            return [node_identity(str(value[0])), value[1]]
        return file_identity(key, value)

    own_inputs = prompt.get(str(unique_id), {}).get("inputs", {})
    runtime_sources = {}
    for node_id in ("SPEEDSampler", "SPEEDSamplerManual", "MiniMaxH3ImageToVideo", "VAEDecode", "VAEDecodeAudio"):
        cls = nodes.NODE_CLASS_MAPPINGS.get(node_id)
        if cls:
            import sys
            file = Path(sys.modules[cls.__module__].__file__)
            runtime_sources[node_id] = file.stat().st_mtime_ns
    return digest([source_digest(), runtime_sources, {key: resolve(key, own_inputs.get(key)) for key in
                                                    ("model", "clip", "video_vae", "audio_vae", "inner_sampler")}])


def run_project(project_json, action_json, model, clip, video_vae, audio_vae, graph, node_id,
                first_frame=None, inner_sampler=None):
    started = time.monotonic()
    raw = json.loads(project_json)
    project = validate_project(raw)
    ids = [scene["id"] for scene in project["scenes"]]
    action = parse_action(action_json, ids)
    job = get_executing_context()
    base = project_root(project["id"])
    cache_dir = base / "cache"
    final_dir = output_root(project["id"])
    state_path = base / "status.json"
    prior = read_json(state_path, {})
    state = {
        "project": project["id"], "project_digest": digest(raw), "session": SESSION, "node": node_id,
        "prompt_id": job.prompt_id if job else None, "phase": "starting",
        "scenes": {key: value for key, value in prior.get("scenes", {}).items() if key in ids},
        "completed": 0, "total": 0,
        "film": prior.get("film"),
        "film_stale": bool(prior.get("film_stale") or prior.get("film")),
    }
    native = None
    live = None
    preview_requested = project["live_preview"]["enabled"]

    def status(phase, **values):
        state.update(values, phase=phase)
        write_json(state_path, state)
        server = PromptServer.instance
        if server and server.client_id:
            server.send_sync("h3-speed-director.progress",
                             {k: v for k, v in state.items() if k != "scenes"}, server.client_id)

    try:
        status("starting")
        server = PromptServer.instance
        write_json(base / "last-render-project.json", raw)
        if not (base / "project.json").is_file():
            write_json(base / "project.json", raw)
        for managed in (cache_dir, base / "delivery", base / "scenes", final_dir):
            cleanup(managed)
        ffmpeg_path()
        delivery = project["delivery"]
        if not action:
            check_delivery(delivery)
        native = NativeH3(model, clip, video_vae, audio_vae, inner_sampler)
        native_id = fingerprint(graph, node_id)
        scenes = project["scenes"]
        if action:
            end = ids.index(action["scene"])
            first = end
            while first > 0 and fantastic.depends_on_previous(scenes[first]):
                first -= 1
            selected = scenes[first:end + 1]
        else:
            selected = scenes
        state["total"] = sum(len(scene["passes"]) for scene in selected)
        plans = {}
        asset_records = {}

        def asset_record(asset):
            if asset is None:
                return None
            if asset not in asset_records:
                path = asset_path(asset)
                if not path.is_file():
                    raise ValueError(f"Missing Director reference media ({asset})")
                with path.open("rb") as source:
                    asset_records[asset] = (hashlib.file_digest(source, "sha256").hexdigest(), path)
            return asset_records[asset]

        if first_frame is not None:
            if first_frame.ndim != 4 or len(first_frame) == 0 or first_frame.shape[-1] < 3:
                raise ValueError("The connected first frame is an empty or invalid image batch")
            if scenes[0]["passes"][0]["generation"] == "legacy" and scenes[0].get("first_frame"):
                raise ValueError("Choose either the first scene's start image or the connected first frame")
            first_frame = first_frame[:1, ..., :3].detach().float().cpu().contiguous()
            graph_image = (hashlib.sha256(first_frame.numpy().tobytes()).hexdigest(), list(first_frame.shape))
        else:
            graph_image = None
        has_fantastic = any(beat["generation"] != "legacy" for scene in selected for beat in scene["passes"])
        fantastic_id = fantastic.identity() if has_fantastic else None
        for scene in selected:
            for n, beat in enumerate(scene["passes"], 1):
                try:
                    native.prepare(beat["settings"])
                    if beat["generation"] == "legacy":
                        for asset in [*scene["references"], scene.get("first_frame"), scene.get("last_frame")]:
                            asset_record(asset)
                    else:
                        builder = beat["builder"] or {}
                        seconds = builder.get("duration")
                        if (not beat["prompt"].strip() or builder.get("mode") != beat["generation"] or type(seconds) not in (int, float)
                                or abs(seconds * FPS - beat["settings"]["frames"]) > 1e-6):
                            raise ValueError("The Fantastic prompt is out of sync. Open it in the Director to update its mode and duration.")
                        plan = fantastic.plan(scene, beat, scene["id"] == ids[0] and n == 1 and graph_image is not None)
                        for asset in plan.get("pictures", []) + plan.get("audios", []) + [v["asset"] for v in plan.get("videos", [])]:
                            asset_record(asset)
                        for role in ("first", "last"):
                            asset = plan.get(role)
                            if asset and "." in asset:
                                asset_record(asset)
                        plans[(scene["id"], beat["id"])] = plan
                except (ValueError, RuntimeError) as error:
                    raise ValueError(f"{scene['title']} · pass {n}: {error}") from error

        if action and action["nonce"]:
            write_json(base / "revisions" / f"{action['scene']}.json", action["nonce"])
        previous_scene = None
        film_passes = []
        generated, reused = 0, 0
        for scene in selected:
            scene_id = scene["id"]
            revision = read_json(base / "revisions" / f"{scene_id}.json")
            active = []
            scene_status = {"title": scene["title"], "state": "rendering", "passes": [], "takes": {}}
            state["scenes"][scene_id] = scene_status
            for n, beat in enumerate(scene["passes"], 1):
                interrupt()
                settings = beat["settings"]
                context = {"scene": scene_id, "pass_index": n, "pass_count": len(scene["passes"])}
                generation = beat["generation"]
                plan = plans.get((scene_id, beat["id"]))
                beginning = ending = None
                references = []
                continuous = False
                if plan is not None:
                    start = plan.get("first")
                    if start == "scene-tail":
                        beginning, continuous = boundary(previous_scene, "tail"), True
                    elif start == "pass-tail":
                        beginning, continuous = boundary(active[-1], "tail"), True
                    elif start == "pass-head":
                        beginning, continuous = boundary(active[-1], "head"), active[-1]["continuous"]
                    elif start == "graph":
                        beginning = (graph_image, None)
                    else:
                        beginning = asset_record(start)
                    end = plan.get("last")
                    ending = boundary(active[-1], "tail") if end == "pass-tail" else asset_record(end)
                    references = [asset_record(asset) for asset in plan.get("pictures", [])]
                    if plan.get("previous"):
                        references.insert(0, boundary(previous_scene, "tail"))
                else:
                    ending = asset_record(scene.get("last_frame")) if n == len(scene["passes"]) else None
                    references = [asset_record(asset) for asset in scene["references"]]
                    if beat["mode"] == "generate":
                        beginning = asset_record(scene.get("first_frame"))
                        if scene_id == ids[0] and graph_image is not None:
                            beginning = (graph_image, None)
                        if scene["transition"] == "continuous":
                            beginning = boundary(previous_scene, "tail")
                            continuous = True
                        if scene["transition"] == "reference" and scene["previous_reference"]:
                            references.insert(0, boundary(previous_scene, "tail"))
                    elif beat["mode"] == "extend":
                        beginning = boundary(active[-1], "tail")
                        continuous = True
                    else:
                        beginning = boundary(active[-1], "head")
                        ending = ending or boundary(active[-1], "tail")
                        continuous = active[-1]["continuous"]
                trim = continuous and settings["trim_overlap"]
                prompt = beat["prompt"]
                if generation == "legacy":
                    prompt = "\n\n".join(
                        [f"{label} — {project[key]}" for key, label in
                         (("character", "Character"), ("environment", "Environment"), ("style", "Visual style")) if project.get(key)]
                        + [prompt]
                    ).strip()
                    if references and "<Picture " not in prompt:
                        tags = ", ".join(f"<Picture {i}>" for i in range(1, len(references) + 1))
                        prompt = (prompt + f"\nUse {tags} as visual references.").strip()
                inputs = [native_id, scene_id, beat["id"], revision, settings, beat["mode"], prompt,
                          beat["negative"], trim, beginning[0] if beginning else None,
                          ending[0] if ending else None, [ref[0] for ref in references]]
                if plan is not None:
                    inputs.extend(["fantastic-v1", fantastic_id, generation, plan.get("image_size"),
                                   [(asset_record(v["asset"])[0], v["audio_mode"]) for v in plan.get("videos", [])],
                                   [asset_record(a)[0] for a in plan.get("audios", [])]])
                key = digest(inputs)
                target = cache_dir / key
                if pass_complete(target):
                    manifest = read_json(target / "manifest.json")
                    reused += 1
                    status("cached", **context)
                else:
                    if target.exists():
                        shutil.rmtree(target)
                    if live is None and preview_requested and server.client_id:
                        live = LivePreview(project["live_preview"], server, server.client_id, project["id"], state["prompt_id"])
                    status("conditioning", **context)
                    av_references = fantastic.load_av(plan["videos"], plan["audios"], settings["frames"],
                                                       settings["width"], settings["height"]) if generation == "REF" else None
                    image, audio, stats = native.generate(
                        settings, prompt, beat["negative"],
                        load_image(beginning, first_frame), load_image(ending),
                        [load_image(ref) for ref in references],
                        lambda phase: status(phase, **context),
                        generation=generation, av_references=av_references,
                        ref_image_size=plan.get("image_size", "match") if plan else "match",
                        live=live, live_context=context | {"scene_title": scene["title"]},
                    )
                    del av_references
                    if generation != "legacy":
                        stats["generation"] = generation
                    with staging(cache_dir, target) as work:
                        status("saving", **context)
                        manifest = write_pass(work, image, audio, trim) | stats
                        write_json(work / "manifest.json", manifest)
                    del image, audio
                    generated += 1
                entry = manifest | {"token": key, "directory": target, "continuous": continuous}
                if beat["mode"] == "replace":
                    active[-1] = entry
                else:
                    active.append(entry)
                scene_status["passes"] = [{k: value for k, value in item.items() if k not in ("directory", "continuous")}
                                          for item in active]
                scene_status["takes"][beat["id"]] = key
                state["completed"] += 1
                status("cached" if generated == 0 else "saving", **context)
            scene_status["state"] = "ready"
            previous_scene = active[-1]
            film_passes.extend(active)
            if len(active) > 1:
                _, preview = assemble(base, base / "scenes", active, active[0]["width"], active[0]["height"],
                                      {"fps": 24, "rtx_scale": 1, "rife": False, "rtx_quality": "ULTRA"}, status)
                scene_status["preview"] = preview
            status("saving", scene=scene_id)

        if action:
            film_passes = active
            destination = base / "scenes"
            delivery = {"fps": 24, "rtx_scale": 1.0, "rife": False, "rtx_quality": "ULTRA"}
        else:
            destination = final_dir
        width, height = (project["settings"][axis] for axis in ("width", "height"))
        output, render_key = assemble(base, destination, film_passes, width, height, delivery, status)
        if action:
            state["scenes"][action["scene"]]["preview"] = render_key
            if not generated and state["project_digest"] == prior.get("project_digest"):
                state["film_stale"] = bool(prior.get("film_stale"))
        else:
            state["film"] = render_key
            state["film_stale"] = False
        if live is not None:
            live.close()
        elapsed = round(time.monotonic() - started, 3)
        report = {"generated_passes": generated, "cached_passes": reused,
                  "render_seconds": elapsed, "frames_at_24": sum(item["frames"] for item in film_passes),
                  "delivery_fps": delivery["fps"], "output": str(output),
                  "live_preview": {"enabled": preview_requested, "active": live is not None} |
                                  (live.stats() if live is not None else {})}
        status("complete", scene=None, report=report,
               result_preview={"kind": "scene" if action else "film", "token": render_key})
        return VideoFromFile(str(output)), json.dumps(report)
    except comfy.model_management.InterruptProcessingException:
        status("interrupted")
        raise
    except Exception as error:
        status("failed", error=str(error)[:1200])
        raise
    finally:
        if live is not None:
            live.close()
        if native is not None:
            native.close()


def boundary(entry, side):
    return ([entry["token"], side], entry["directory"] / f"{side}.npy")


def load_image(asset, connected=None):
    if asset:
        return read_frame(asset[1]) if asset[1] is not None else connected
    return None


def assemble(base, destination, entries, width, height, delivery, status):
    render_key = digest([source_digest(), [entry["token"] for entry in entries], width, height, delivery])
    output = destination / f"{render_key}.mp4"
    if not output.is_file():
        segments = []
        for i, entry in enumerate(entries):
            interrupt()
            next_entry = entries[i + 1] if i + 1 < len(entries) and entries[i + 1]["continuous"] else None
            segment = delivered_video(base, entry, width, height, delivery, status, next_entry)
            segments.append((segment, entry["directory"] / "audio.wav", entry["frames"]))
        destination.mkdir(parents=True, exist_ok=True)
        status("assembly")
        with tempfile.TemporaryDirectory(prefix=".work-", dir=destination) as temporary:
            staging_video = Path(temporary) / "result.mp4"
            concatenate(staging_video, segments)
            staging_video.replace(output)
    return output, render_key


def delivered_video(base, entry, width, height, delivery, status, next_entry):
    source = entry["directory"] / "video.mp4"
    if delivery["fps"] == 24 and delivery["rtx_scale"] == 1 and (width, height) == (entry["width"], entry["height"]):
        return source
    next_clip = next_entry if delivery["rife"] else None
    token = digest([source_digest(), entry["token"], width, height, delivery, next_clip["token"] if next_clip else None])
    directory = base / "delivery"
    target = directory / token
    path = target / "video.mp4"
    if not path.is_file():
        if target.exists():
            shutil.rmtree(target)
        status("delivery")
        with staging(directory, target) as work:
            finish_pass(source, work / "video.mp4", entry["frames"], width, height, delivery,
                        next_clip["directory"] / "video.mp4" if next_clip else None)
    return path

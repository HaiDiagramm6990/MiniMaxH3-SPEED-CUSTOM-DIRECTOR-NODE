import asyncio
import io
import json
from pathlib import Path
import tempfile
import uuid

import av
from aiohttp import web
import numpy as np
from PIL import Image

import comfy.samplers
import nodes
from server import PromptServer

from . import fantastic
from .live_preview import available as live_preview_available
from .project import ASSET, AUDIO_ASSET, ID, LIVE_PREVIEW_LIMITS, TOKEN, VIDEO_ASSET, default_project, validate_project
from .storage import NODE_TYPE, SESSION, asset_path, project_root, read_json, render_location, root, write_json

API = "/h3-speed-director"
CONTAINERS = {"mp4": "mov", "mov": "mov", "mkv": "matroska", "webm": "matroska",
              "wav": "wav", "mp3": "mp3", "flac": "flac", "m4a": "mov", "ogg": "ogg"}
CACHE_HEADER = {"Cache-Control": "private, max-age=31536000, immutable"}


def known_asset(asset):
    return any(pattern.fullmatch(asset) for pattern in (ASSET, VIDEO_ASSET, AUDIO_ASSET))


def register_routes():
    server = PromptServer.instance
    routes = server.routes

    @routes.get(API + "/options")
    async def options(request):
        return web.json_response({
            "project": default_project(), "samplers": comfy.samplers.SAMPLER_NAMES,
            "schedulers": comfy.samplers.SCHEDULER_NAMES,
            "rife": "RIFEInterpolation" in nodes.NODE_CLASS_MAPPINGS,
            "rtx": "RTXVideoSuperResolution" in nodes.NODE_CLASS_MAPPINGS,
            "fantastic": fantastic.BUILDER in nodes.NODE_CLASS_MAPPINGS,
            "save_preview": True,
            "boundary_thumbnails": True,
            "live_preview": {"available": live_preview_available(), "limits": LIVE_PREVIEW_LIMITS},
        })

    @routes.get(API + "/fantastic.js")
    async def fantastic_bridge(request):
        try:
            source = fantastic.compiler_source()
        except (AttributeError, OSError, RuntimeError) as error:
            raise web.HTTPServiceUnavailable(text=str(error))
        return web.Response(text=source, content_type="application/javascript", headers={"Cache-Control": "no-cache"})

    @routes.get(API + "/projects")
    async def projects(request):
        values = []
        for path in (root() / "projects").glob("*/project.json"):
            if ID.fullmatch(path.parent.name):
                value = read_json(path)
                if value:
                    values.append({"id": value["id"], "name": value.get("name", "Untitled film"),
                                   "modified": path.stat().st_mtime})
        return web.json_response(sorted(values, key=lambda entry: -entry["modified"]))

    @routes.post(API + "/validate")
    async def validate(request):
        try:
            validate_project(await request.json())
        except (ValueError, TypeError, KeyError) as error:
            raise web.HTTPBadRequest(text=str(error))
        return web.json_response({"valid": True})

    @routes.get(API + "/project/{project_id}")
    async def get_project(request):
        path = checked_project_path(request)
        value = read_json(path / "project.json")
        if value is None:
            raise web.HTTPNotFound()
        return web.json_response(value)

    @routes.put(API + "/project/{project_id}")
    async def put_project(request):
        path = checked_project_path(request)
        try:
            value = await request.json()
            validate_project(value)
            if value["id"] != path.name:
                raise ValueError("Project ID differs from the destination")
        except (ValueError, TypeError, KeyError) as error:
            raise web.HTTPBadRequest(text=str(error))
        write_json(path / "project.json", value)
        return web.json_response({"id": path.name})

    @routes.get(API + "/status/{project_id}")
    async def status(request):
        path = checked_project_path(request)
        state = read_json(path / "status.json", {})
        running, pending = server.prompt_queue.get_current_queue_volatile()
        state["queued"] = any(owns_project(item, path.name) for item in pending)
        if state.get("phase") in ("starting", "conditioning", "sampling", "decoding", "saving", "delivery", "assembly", "cached"):
            if state.get("session") != SESSION or not any(item[1] == state.get("prompt_id") for item in running):
                state["phase"] = "interrupted"
        return web.json_response(state, headers={"Cache-Control": "no-store"})

    @routes.post(API + "/cancel/{project_id}")
    async def cancel(request):
        path = checked_project_path(request)
        if not server.prompt_queue:
            raise web.HTTPConflict(text="ComfyUI queue is unavailable")
        running, pending = server.prompt_queue.get_current_queue_volatile()
        matching = next((item for item in running + pending if owns_project(item, path.name)), None)
        if matching is None:
            return web.json_response({"cancelled": False})
        prompt_id = matching[1]
        cancelled = server.prompt_queue.interrupt_if_running(prompt_id)
        if not cancelled:
            cancelled = server.prompt_queue.delete_queue_item(lambda item: item[1] == prompt_id)
        if not cancelled:
            cancelled = server.prompt_queue.interrupt_if_running(prompt_id)
        return web.json_response({"cancelled": bool(cancelled)})

    @routes.get(API + "/assets")
    async def get_assets(request):
        out = []
        directory = root() / "assets"
        for path in directory.glob("*.json"):
            value = read_json(path)
            if value and known_asset(value.get("id", "")) and asset_path(value["id"]).is_file():
                out.append({"kind": "image"} | value)
        return web.json_response(sorted(out, key=lambda entry: entry["name"].casefold()))

    @routes.post(API + "/assets")
    async def add_asset(request):
        reader = await request.multipart()
        part = await reader.next()
        if part is None or part.name != "image" or not part.filename:
            raise web.HTTPBadRequest(text="Expected a reference file")
        name = part.filename.replace("\\", "/").rsplit("/", 1)[-1]
        suffix = Path(name).suffix.lower().lstrip(".")
        is_av = suffix in CONTAINERS
        max_mib = 64 if is_av else 20
        token = uuid.uuid4().hex
        directory = asset_path(f"{token}.{suffix if is_av else 'png'}").parent
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".upload-", dir=directory) as staging:
            temporary = Path(staging) / "reference"
            size = 0
            with temporary.open("wb") as output:
                while chunk := await part.read_chunk():
                    size += len(chunk)
                    if size > max_mib * 1024 * 1024:
                        raise web.HTTPBadRequest(text=f"Reference file exceeds {max_mib} MiB")
                    output.write(chunk)
            try:
                if is_av:
                    video = bool(VIDEO_ASSET.fullmatch(f"{token}.{suffix}"))
                    with av.open(str(temporary), format=CONTAINERS[suffix]) as source:
                        has_audio = bool(source.streams.audio)
                        if video and not source.streams.video:
                            raise ValueError("The file has no video stream")
                        if not video and not has_audio:
                            raise ValueError("The file has no audio stream")
                        value = {"kind": "video" if video else "audio", "has_audio": has_audio}
                else:
                    with Image.open(temporary, formats=["PNG", "JPEG", "WEBP"]) as image:
                        suffix = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[image.format]
                        if image.width * image.height > 24_000_000 or getattr(image, "is_animated", False):
                            raise ValueError("Use a single image of at most 24 megapixels")
                        image.load()
                    value = {"kind": "image"}
            except (OSError, ValueError, av.FFmpegError, Image.DecompressionBombError) as error:
                raise web.HTTPBadRequest(text=f"Invalid reference file: {error}")
            asset_id = f"{token}.{suffix}"
            temporary.rename(asset_path(asset_id))
            value.update(id=asset_id, name=name[:150])
            write_json(root() / "assets" / f"{asset_id}.json", value)
            return web.json_response(value)

    @routes.get(API + "/assets/{asset}")
    async def get_asset(request):
        asset = request.match_info["asset"]
        if not known_asset(asset):
            raise web.HTTPNotFound()
        return static_file(asset_path(asset))

    @routes.get(API + "/media/{project_id}/{token}/{asset}")
    async def get_media(request):
        project_id = checked_project_path(request).name
        token, asset = request.match_info["token"], request.match_info["asset"]
        if not TOKEN.fullmatch(token) or asset not in ("thumbnail", "preview", "scene", "film", "head", "tail"):
            raise web.HTTPNotFound()
        path = render_location(project_id, token, asset)
        if asset in ("head", "tail"):
            try:
                data = await asyncio.to_thread(boundary_thumbnail, path)
            except FileNotFoundError:
                raise web.HTTPNotFound() from None
            return web.Response(body=data, content_type="image/jpeg", headers=CACHE_HEADER)
        return static_file(path)


def owns_project(item, project_id):
    for entry in item[2].values():
        if entry.get("class_type") != NODE_TYPE:
            continue
        try:
            if json.loads(entry["inputs"]["project"]).get("id") == project_id:
                return True
        except (ValueError, TypeError, KeyError, AttributeError):
            pass
    return False


def checked_project_path(request):
    project_id = request.match_info["project_id"]
    if not ID.fullmatch(project_id):
        raise web.HTTPNotFound()
    return project_root(project_id)


def static_file(path):
    if not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers=CACHE_HEADER)


def boundary_thumbnail(path):
    frame = np.load(path, mmap_mode="r", allow_pickle=False)
    stride = max(1, max(frame.shape[:2]) // 320)
    image = Image.fromarray((np.clip(frame[::stride, ::stride], 0, 1) * 255).round().astype(np.uint8))
    image.thumbnail((320, 320))
    with io.BytesIO() as out:
        image.save(out, format="JPEG", quality=86)
        return out.getvalue()

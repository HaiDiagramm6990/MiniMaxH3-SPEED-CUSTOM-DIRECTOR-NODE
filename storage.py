from contextlib import contextmanager
from pathlib import Path
import json
import os
import shutil
import tempfile
import time
import uuid

import folder_paths

from .project import ASSET

SESSION = uuid.uuid4().hex
NODE_TYPE = "H3SpeedDirector"


def root():
    return Path(folder_paths.get_user_directory()) / "h3_speed_director"


def project_root(project_id):
    return root() / "projects" / project_id


def asset_path(asset):
    if ASSET.fullmatch(asset):
        return root() / "assets" / asset
    return Path(folder_paths.get_input_directory()) / "h3_speed_director" / asset


def output_root(project_id):
    return Path(folder_paths.get_output_directory()) / "H3-SpeedDirector" / project_id


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".write-", delete=False, mode="w", encoding="utf-8") as out:
        temporary = Path(out.name)
        try:
            json.dump(value, out, ensure_ascii=False, allow_nan=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        except BaseException:
            out.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        for attempt in range(6):
            try:
                os.replace(temporary, path)
                break
            except PermissionError as error:
                # Windows status polling can temporarily hold the old file open.
                if getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 5:
                    raise
                time.sleep(0.01 * 2**attempt)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def staging(directory, target):
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".work-", dir=directory) as temporary:
        path = Path(temporary)
        yield path
        path.rename(target)


def cleanup(directory):
    for path in directory.glob(".work-*"):
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)


def pass_complete(path):
    return all((path / file).is_file() for file in (
        "manifest.json", "head.npy", "tail.npy", "thumbnail.jpg", "video.mp4", "preview.mp4", "audio.wav",
    ))


def render_location(project_id, token, asset):
    if asset == "film":
        return output_root(project_id) / f"{token}.mp4"
    if asset == "scene":
        return project_root(project_id) / "scenes" / f"{token}.mp4"
    filename = {"preview": "preview.mp4", "thumbnail": "thumbnail.jpg", "head": "head.npy", "tail": "tail.npy"}[asset]
    return project_root(project_id) / "cache" / token / filename

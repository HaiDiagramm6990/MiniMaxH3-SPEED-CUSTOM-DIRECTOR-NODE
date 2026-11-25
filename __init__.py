from comfy_api.latest._input_impl.video_types import VideoFromFile

from .engine import run_project
from .project import TOKEN, identifier
from .routes import register_routes
from .storage import NODE_TYPE, render_location


class H3SpeedDirector:
    CATEGORY = "video/H3 SPEED"
    DESCRIPTION = "Direct a multi-scene MiniMax H3 film using the installed native SPEED AV sampler."
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO", "STRING")
    RETURN_NAMES = ("film", "render_report")
    FUNCTION = "render"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "video_vae": ("VAE",),
                "audio_vae": ("VAE",),
                "project": ("STRING", {"default": "", "multiline": True}),
                "action": ("STRING", {"default": ""}),
            },
            "optional": {"first_frame": ("IMAGE",), "inner_sampler": ("SAMPLER",)},
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **inputs):
        # The Director owns disk checkpointing and rechecks assets and render actions on each queue entry.
        return float("nan")

    def render(self, model, clip, video_vae, audio_vae, project, action, prompt, unique_id,
               first_frame=None, inner_sampler=None):
        return run_project(project, action, model, clip, video_vae, audio_vae, prompt, unique_id,
                           first_frame, inner_sampler)


class H3SpeedDirectorRenderedVideo:
    CATEGORY = "video/H3 SPEED"
    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "load"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project_id": ("STRING",), "token": ("STRING",),
                             "kind": (["film", "scene", "preview"],)}}

    def load(self, project_id, token, kind):
        identifier(project_id, "Project ID")
        if not TOKEN.fullmatch(token) or kind not in ("film", "scene", "preview"):
            raise ValueError("Invalid Director render selection")
        path = render_location(project_id, token, kind)
        if not path.is_file():
            raise ValueError("This Director render is no longer available")
        return (VideoFromFile(str(path)),)


NODE_CLASS_MAPPINGS = {NODE_TYPE: H3SpeedDirector, "H3SpeedDirectorRenderedVideo": H3SpeedDirectorRenderedVideo}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_TYPE: "H3 SPEED Director", "H3SpeedDirectorRenderedVideo": "H3 Director Rendered Video"}
WEB_DIRECTORY = "./web"

register_routes()

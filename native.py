import functools
import importlib
import time
from pathlib import Path

import torch

import comfy.latent_formats
import comfy.model_base
import comfy.model_management
import comfy.model_sampling
import comfy.samplers
import nodes
from comfy_extras.nodes_audio import VAEDecodeAudio
from comfy_extras.nodes_custom_sampler import BasicGuider, BasicScheduler, CFGGuider, KSamplerSelect, RandomNoise
from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide, MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo, MiniMaxH3SigmaShift, video_latent_t

from . import fantastic
from .live_preview import sampling_progress, suppress_upstream
from .project import FPS, KEYFRAMES


def interrupt():
    comfy.model_management.throw_exception_if_processing_interrupted()


def registered(node_id):
    cls = nodes.NODE_CLASS_MAPPINGS.get(node_id)
    if cls is None:
        raise RuntimeError(f"Required ComfyUI node {node_id} is unavailable. Check the node package startup log.")
    return cls


def check_delivery(delivery):
    if delivery["rife"]:
        cls = registered("RIFEInterpolation")
        import folder_paths
        module = importlib.import_module(cls.__module__)
        candidates = (Path(module.__file__).parent / "rife" / "train_log" / "flownet.pkl",
                      Path(module.__file__).parent / "models" / "flownet.pkl",
                      Path(folder_paths.models_dir) / "rife" / "flownet.pkl")
        if not any(p.is_file() for p in candidates):
            raise ValueError("Install flownet.pkl in the existing RIFE package or models/rife before enabling RIFE")
    if delivery["rtx_scale"] > 1:
        registered("RTXVideoSuperResolution")


class NativeH3:
    def __init__(self, model, clip, video_vae, audio_vae, sampler=None):
        if not isinstance(model.model, comfy.model_base.MiniMaxH3) or not isinstance(
            model.model.latent_format, comfy.latent_formats.MiniMaxH3AV
        ):
            raise ValueError("Connect a MiniMax H3 audio/video MODEL")
        if not isinstance(model.get_model_object("model_sampling"), comfy.model_sampling.ModelSamplingAV):
            raise ValueError("The connected model needs MiniMax H3 AV model sampling")
        if getattr(video_vae, "latent_channels", None) != 24 or getattr(audio_vae, "latent_channels", None) != 32:
            raise ValueError("Connect the H3 video VAE (24 channels) and H3 audio VAE (32 channels)")
        self.model = model
        self.clip = clip
        self.video_vae = video_vae
        self.audio_vae = audio_vae
        self.sampler = sampler

    @functools.lru_cache(maxsize=4)
    def shifted(self, video, audio):
        return suppress_upstream(MiniMaxH3SigmaShift.execute(self.model, video, audio).args[0])

    @functools.lru_cache(maxsize=64)
    def controls(self, width, height, frames, steps, scheduler, sampler_name, shift_video, shift_audio,
                 denoise, speed_mode, policy, offset, stages, delta, amplitude, exponent, units, transitions):
        cls = registered("SPEEDSamplerManual" if speed_mode == "manual" else "SPEEDSampler")
        module = importlib.import_module(cls.__module__)
        plan_tools = importlib.import_module(module.run_speed_pipeline.__module__.rsplit(".", 1)[0] + ".planning")
        model = self.shifted(shift_video, shift_audio)
        if scheduler not in comfy.samplers.SCHEDULER_NAMES:
            raise ValueError(f"Unknown ComfyUI scheduler {scheduler!r}")
        if self.sampler is None and sampler_name not in comfy.samplers.SAMPLER_NAMES:
            raise ValueError(f"Unknown ComfyUI inner sampler {sampler_name!r}")
        sigmas = BasicScheduler.execute(model, scheduler, steps, denoise).args[0]
        if speed_mode == "manual":
            config = plan_tools.build_manual_speed_config(
                sigmas, transitions=transitions, ratio_mode=units, noise_policy=policy, seed_offset=offset,
            )
        else:
            config = plan_tools.build_automatic_speed_config(
                stages=stages, delta=delta, noise_amplitude=amplitude, noise_decay_exponent=exponent,
                noise_policy=policy, seed_offset=offset,
            )
        plan = plan_tools.plan_stages(config, sigmas, (1, 24, video_latent_t(frames), height // 16, width // 16))
        if len(plan.scales) < 2:
            raise ValueError("This SPEED schedule has no progressive stages. Increase denoise or use a manual SPEED schedule.")
        if len(set(plan.transition_steps)) != len(plan.transition_steps):
            raise ValueError(
                f"Native SPEED mapped several stages onto the same step {plan.transition_steps}. "
                "Use fewer stages, more steps, a different tolerance or explicit manual boundaries."
            )
        sampler = self.sampler or KSamplerSelect.execute(sampler_name).args[0]
        return model, sigmas, cls, module.run_speed_pipeline, config, sampler, plan

    def prepare(self, options):
        return self.controls(*(
            options[field] for field in (
                "width", "height", "frames", "steps", "scheduler", "sampler", "shift_video", "shift_audio",
                "denoise", "speed_mode", "noise_policy", "seed_offset", "stages", "delta", "amplitude",
                "exponent", "ratio_mode",
            )
        ), tuple(map(tuple, options["transitions"])))

    def close(self):
        # functools caches on methods are shared by their wrapper and retain self.
        self.controls.cache_clear()
        self.shifted.cache_clear()

    def generate(self, beat, prompt, negative, first, last, references, notify, *,
                 generation="legacy", av_references=None, ref_image_size="match", live=None, live_context=None):
        model, sigmas, cls, speed, config, sampler, plan = self.prepare(beat)
        canvas = {k: beat[k] for k in ("width", "height")} | {"length": beat["frames"]}

        if generation == "REF":
            prompt, conditioned = fantastic.gated(generation, prompt, {"pictures": references} | (av_references or {}))
            ref_inputs = {
                key: {f"{prefix}_{i}": item for i, item in enumerate(conditioned[group], 1) if item is not None}
                for key, prefix, group in (("ref_images", "ref_image", "pictures"), ("ref_videos", "ref_video", "videos"),
                    ("ref_video_audios", "ref_video_audio", "video_audios"), ("ref_audios", "ref_audio", "audios"))
            }
        elif generation != "legacy":
            roles = KEYFRAMES[generation]
            endpoints = {"first": first, "last": last}
            prompt, conditioned = fantastic.gated(generation, prompt, {"pictures": [endpoints[role] for role in roles]})
            frames = dict(zip(roles, conditioned["pictures"]))
            first, last = frames.get("first"), frames.get("last")

        def encode(value):
            if generation == "REF":
                return MiniMaxH3ReferenceToVideo.execute(
                    self.clip, value, **canvas, vae=self.video_vae, audio_vae=self.audio_vae,
                    ref_image_size=ref_image_size, **ref_inputs,
                ).args
            if references:
                positive, latent = MiniMaxH3ReferenceToVideo.execute(
                    self.clip, value, **canvas, vae=self.video_vae,
                    ref_images={f"ref_image_{i}": item for i, item in enumerate(references, 1)},
                ).args
                for frame, index in ((first, 0), (last, beat["frames"] - 1)):
                    if frame is not None:
                        positive = MiniMaxH3AddGuide.execute(
                            positive, latent, index, vae=self.video_vae, image=frame,
                        ).args[0]
                return positive, latent
            return MiniMaxH3ImageToVideo.execute(
                self.clip, self.video_vae, value, **canvas, first_frame=first, last_frame=last,
            ).args

        device = comfy.model_management.get_torch_device()
        gpu = device.type == "cuda"
        start = time.monotonic()
        if gpu:
            torch.cuda.reset_peak_memory_stats(device)
        notify("conditioning")
        interrupt()
        positive, latent = encode(prompt)
        if beat["cfg"] == 1:
            guider = BasicGuider.execute(model, positive).args[0]
        else:
            negative_conditioning, _ = encode(negative)
            guider = CFGGuider.execute(model, positive, negative_conditioning, beat["cfg"]).args[0]
        noise = RandomNoise.execute(int(beat["seed"])).args[0]
        interrupt()
        notify("sampling")
        steps = len(sigmas) - 1
        observer = live.pass_observer(live_context, steps) if live is not None else None
        progress = sampling_progress(guider, steps, observer)
        sampling_start = time.monotonic()
        output, denoised = speed(noise, guider, sigmas, latent, config, sampler=sampler,
                                 model_type=cls.MODEL_TYPE, disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
                                 preview_callback=progress)
        del denoised, guider, latent
        if gpu:
            torch.cuda.synchronize(device)
        sampling_seconds = time.monotonic() - sampling_start
        interrupt()
        notify("decoding")
        images = nodes.VAEDecode().decode(self.video_vae, output)[0]
        interrupt()
        audio = VAEDecodeAudio.execute(self.audio_vae, output).args[0]
        if gpu:
            torch.cuda.synchronize(device)
        if images.shape[0] != beat["frames"]:
            raise RuntimeError(f"H3 decoded {len(images)} frames, expected {beat['frames']} at {FPS} fps")
        stats = {
            "sampler": cls.__name__, "stage_steps": list(plan.transition_steps),
            "stage_shapes": [list(shape) for shape in plan.stage_shapes],
            "sampling_seconds": round(sampling_seconds, 3), "inference_seconds": round(time.monotonic() - start, 3),
            "torch_peak_allocated_mib": round(torch.cuda.max_memory_allocated(device) / 2**20, 1) if gpu else None,
            "torch_peak_reserved_mib": round(torch.cuda.max_memory_reserved(device) / 2**20, 1) if gpu else None,
        }
        return images, audio, stats

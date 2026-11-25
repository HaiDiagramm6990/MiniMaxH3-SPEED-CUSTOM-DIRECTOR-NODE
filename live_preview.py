"""Low-overhead sampling telemetry and KJ tiny-VAE previews for a Director run."""

import base64
import inspect
import io
import logging
import math
import threading
import time

from PIL import Image, ImageOps
import torch

import comfy.patcher_extension
import comfy.utils
import folder_paths
import nodes

CHECKPOINT = "taeh3.safetensors"
KJ_NODE = "ModelPreviewOverrideKJ"
EVENT = "h3-speed-director.live"
UPSTREAM_KEY = "kj_preview_override"
LOG = logging.getLogger(__name__)


def available():
    return KJ_NODE in nodes.NODE_CLASS_MAPPINGS and folder_paths.get_full_path("vae_approx", CHECKPOINT) is not None


def suppress_upstream(model):
    # ModelPatcher wrappers are merged into the guider when sampling starts.
    model.remove_wrappers_with_key(comfy.patcher_extension.WrappersMP.OUTER_SAMPLE, UPSTREAM_KEY)
    return model


def sampling_progress(guider, total_steps, live_stage):
    """Give this guider its own callback options, without changing the connected model."""
    extension = comfy.patcher_extension
    guider.model_options = extension.copy_nested_dicts(guider.model_options)
    wrappers = guider.model_options.get("transformer_options", {}).get("wrappers", {})
    wrappers.get(extension.WrappersMP.OUTER_SAMPLE, {}).pop(UPSTREAM_KEY, None)
    if live_stage is not None:
        extension.add_wrapper_with_key(extension.WrappersMP.OUTER_SAMPLE, EVENT, live_stage,
                                       guider.model_options, is_model_options=True)
    progress = comfy.utils.ProgressBar(total_steps)

    def update(step, x0, x, total):
        progress.update_absolute(step + 1, total)

    return update


class LivePreview:
    def __init__(self, settings, server, client_id, project_id, prompt_id):
        self.settings = settings
        self.server = server
        self.client_id = client_id
        self.job = {"project": project_id, "prompt_id": prompt_id}
        self.decoder = None
        self.encoder = None
        self.kj = None
        self.context = None
        self.closed = False
        self.slot = threading.Lock()
        self.error = None
        self.captured = self.delivered = self.observed = 0
        self.capture_ms = self.decode_ms = self.load_ms = 0.0
        if available():
            try:
                self.kj = inspect.getmodule(nodes.NODE_CLASS_MAPPINGS[KJ_NODE])
                self.encoder = self.kj._AsyncPreviewEncoder(max_in_flight=1)
            except (AttributeError, RuntimeError) as error:
                self.error = f"KJNodes preview worker is unavailable: {error}"
        else:
            self.error = f"Live images need KJNodes and {CHECKPOINT} in models/vae_approx."

    def send(self, kind, context, **data):
        if not self.closed and self.context is context:
            self.server.send_sync(EVENT, self.job | context | {"kind": kind} | data, self.client_id)

    def pass_observer(self, context, total):
        self.context = context
        if self.encoder is not None and self.error is None and self.decoder is None:
            started = time.perf_counter()
            try:
                # KJ builds randomly initialized CPU layers before loading weights.
                # Restore the RNG before starting the native sampler.
                with torch.random.fork_rng(devices=[]):
                    self.decoder = self.kj.load_tiny_vae_decoder(CHECKPOINT, device=torch.device("cpu"), dtype=torch.float32)
                if self.decoder is None or self.decoder.latent_channels != 24:
                    raise RuntimeError(f"Could not load the 24-channel {CHECKPOINT} decoder")
            except (AttributeError, RuntimeError, ValueError) as error:
                self.failed(context, error)
            self.load_ms += (time.perf_counter() - started) * 1000
        self.send("start", context, total=total, error=self.error)
        position, stage_number, last_capture = 0, 0, -math.inf

        def stage(executor, noise, latent_image, sampler, sigmas, denoise_mask=None, callback=None,
                  disable_pbar=False, seed=None, latent_shapes=None):
            nonlocal position, stage_number, last_capture
            stage_number += 1
            actual_sigmas = sigmas.detach().cpu().tolist()
            steps = len(actual_sigmas) - 1
            last = time.perf_counter()

            def observe(step, x0, x, stage_total):
                nonlocal last, last_capture
                now = time.perf_counter()
                sigma = actual_sigmas[step] if 0 <= step < steps else None
                absolute = position + step + 1
                self.observed += 1
                self.send("step", context, step=absolute, total=total, stage=stage_number, sigma=sigma,
                          step_ms=round((now - last) * 1000, 3))
                if self.encoder is not None and self.error is None and now - last_capture >= 0.25:
                    if self.capture(x0, latent_shapes, context, absolute):
                        last_capture = now
                if callback is not None:
                    callback(step, x0, x, stage_total)
                last = time.perf_counter()

            result = executor(noise, latent_image, sampler, sigmas, denoise_mask, observe,
                              disable_pbar, seed, latent_shapes=latent_shapes)
            position += steps
            return result

        return stage

    def capture(self, x0, latent_shapes, context, step):
        if not self.slot.acquire(blocking=False):
            return False
        try:
            started = time.perf_counter()
            if x0.is_nested:
                video = x0.unbind()[0]
            else:
                video = self.kj._normalize_packed_x0(x0, latent_shapes, 0)
            if video.ndim != 5 or video.shape[1] != 24:
                raise ValueError("Expected a 24-channel H3 video latent")
            count = min(self.settings["frames"], video.shape[2])
            spatial_stride = max(1, max(video.shape[-2:]) * 16 // self.settings["resolution"])
            sampled = video[:1, :, :, ::spatial_stride, ::spatial_stride]
            if count < video.shape[2]:
                if getattr(self.decoder, "is_h3", False):
                    sampled = sampled[:, :, :count]
                else:
                    indices = [round(i * (video.shape[2] - 1) / max(1, count - 1)) for i in range(count)]
                    sampled = sampled[:, :, indices]
            snapshot = sampled.detach().to(device="cpu", dtype=torch.float32, copy=True)
            self.capture_ms += (time.perf_counter() - started) * 1000
            if self.encoder.submit(lambda: self.encode(snapshot, context, step)):
                self.captured += 1
                return True
        except (AttributeError, IndexError, RuntimeError, ValueError) as error:
            self.failed(context, error)
        self.slot.release()
        return False

    @torch.inference_mode()
    def encode(self, snapshot, context, step):
        started = time.perf_counter()
        try:
            decoder = self.decoder
            if self.closed or self.context is not context or decoder is None:
                return
            resolution = self.settings["resolution"]
            cap_latent = max(1, resolution // decoder.upscale_ratio)
            h, w = snapshot.shape[-2:]
            if max(h, w) > cap_latent:
                scale = cap_latent / max(h, w)
                stack = snapshot[0].movedim(1, 0)
                size = (max(1, round(h * scale)), max(1, round(w * scale)))
                snapshot = torch.nn.functional.interpolate(stack, size=size, mode="area").movedim(0, 1).unsqueeze(0)
            count = self.settings["frames"]
            frames = self.kj._tiny_vae_decode_to_pil(decoder, snapshot, max_frames=count)
            if len(frames) > count:
                frames = [frames[round(i * (len(frames) - 1) / max(1, count - 1))] for i in range(count)]
            if not frames or self.closed or self.context is not context:
                return
            width, height = frames[0].size
            if max(width, height) > resolution:
                width, height = ImageOps.contain(frames[0], (resolution, resolution)).size
            columns = min(len(frames), 4)
            sheet = Image.new("RGB", (width * columns, height * math.ceil(len(frames) / columns)))
            for i, frame in enumerate(frames):
                if frame.size != (width, height):
                    frame = ImageOps.contain(frame, (resolution, resolution), Image.Resampling.BILINEAR)
                sheet.paste(frame, ((i % columns) * width, (i // columns) * height))
            output = io.BytesIO()
            sheet.save(output, format="JPEG", quality=self.settings["jpeg_quality"])
            self.send("frames", context, step=step, fps=self.settings["fps"], frames=len(frames),
                      width=width, height=height, columns=columns, jpeg=base64.b64encode(output.getvalue()).decode("ascii"))
            self.delivered += 1
        except Exception as error:
            self.failed(context, error)
        finally:
            self.decode_ms += (time.perf_counter() - started) * 1000
            self.slot.release()

    def failed(self, context, error):
        self.error = f"Live images stopped: {error}"
        LOG.warning("H3 SPEED Director live preview: %s", error)
        self.send("error", context, error=self.error)

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.encoder is not None:
            self.encoder.shutdown(drain_timeout=1.0)
        self.decoder = None

    def stats(self):
        return {"steps": self.observed, "snapshots": self.captured, "sheets": self.delivered,
                "capture_ms": round(self.capture_ms, 2), "decode_ms": round(self.decode_ms, 2),
                "load_ms": round(self.load_ms, 2),
                "decoder": CHECKPOINT, "decoder_device": "cpu", "error": self.error}

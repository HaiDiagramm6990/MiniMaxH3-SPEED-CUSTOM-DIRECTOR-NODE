from fractions import Fraction
from pathlib import Path
import subprocess
import tempfile
import time
import wave

import av
import numpy as np
from PIL import Image
import torch

import comfy.audio
import comfy.utils

from .native import interrupt, registered
from .project import FPS

AUDIO_RATE = 48000


def ffmpeg_path():
    from imageio_ffmpeg import get_ffmpeg_exe
    return get_ffmpeg_exe()


def ffmpeg(*args):
    interrupt()
    with tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(
            [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *map(str, args)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            while process.poll() is None:
                interrupt()
                time.sleep(0.1)
            if process.returncode:
                stderr.seek(0)
                raise RuntimeError("FFmpeg failed: " + stderr.read(6000).decode(errors="replace").strip())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def write_video(path, batches, width, height, fps):
    frame_number = 0
    with av.open(str(path), "w", format="mp4") as output:
        stream = output.add_stream("libx264", rate=fps, options={"preset": "veryfast", "crf": "14", "bf": "0"})
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.codec_context.thread_count = 2
        for batch in batches:
            if batch.shape[1:] != (height, width, 3):
                raise ValueError("Delivery processor produced unexpected frame dimensions")
            rgb = (batch.detach().cpu().clamp(0, 1) * 255).round().to(torch.uint8).numpy()
            for array in rgb:
                interrupt()
                frame = av.VideoFrame.from_ndarray(array, format="rgb24")
                frame.pts = frame_number
                frame.time_base = Fraction(1, fps)
                output.mux(stream.encode(frame))
                frame_number += 1
        output.mux(stream.encode(None))
    return frame_number


def write_wave(path, audio, skip_frames, frame_count):
    waveform = audio["waveform"][0, :, :].float().cpu()
    if waveform.ndim != 2 or waveform.shape[0] != 2:
        raise ValueError("Expected a stereo waveform from the H3 audio VAE")
    rate = audio["sample_rate"]
    waveform = comfy.audio.resample(waveform, rate, AUDIO_RATE) if rate != AUDIO_RATE else waveform
    samples_per_frame = AUDIO_RATE // FPS
    required = samples_per_frame * frame_count
    waveform = waveform[:, skip_frames * samples_per_frame:skip_frames * samples_per_frame + required].contiguous()
    if waveform.shape[1] < required:
        waveform = torch.nn.functional.pad(waveform, (0, required - waveform.shape[1]))
    pcm = (waveform.movedim(0, 1).clamp(-1, 1) * 32767).round().numpy().astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setparams((2, 2, AUDIO_RATE, 0, "NONE", "not compressed"))
        output.writeframes(pcm.tobytes())


def write_pass(directory, images, audio, trim):
    skip = int(trim)
    count, height, width, _ = images.shape
    for name, frame in (("head", images[0]), ("tail", images[-1])):
        np.save(directory / f"{name}.npy", frame.detach().float().cpu().numpy(), allow_pickle=False)
    thumb = Image.fromarray((images[skip].detach().cpu().clamp(0, 1) * 255).round().byte().numpy())
    thumb.thumbnail((320, 200))
    thumb.save(directory / "thumbnail.jpg", quality=88)
    write_video(directory / "video.mp4", images[skip:].split(8), width, height, FPS)
    write_wave(directory / "audio.wav", audio, skip, count - skip)
    ffmpeg("-i", directory / "video.mp4", "-i", directory / "audio.wav", "-c:v", "copy",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", directory / "preview.mp4")
    return {"frames": count - skip, "width": width, "height": height}


def read_frame(path):
    if path.suffix == ".npy":
        return torch.from_numpy(np.load(path, allow_pickle=False)).unsqueeze(0)
    from PIL import ImageOps
    with Image.open(path) as image:
        pixels = np.array(ImageOps.exif_transpose(image).convert("RGB"))
    return torch.from_numpy(pixels).unsqueeze(0).float().div_(255)


def frames(path):
    with av.open(str(path)) as source:
        for frame in source.decode(video=0):
            interrupt()
            yield torch.from_numpy(frame.to_ndarray(format="rgb24")).float().div_(255)


def match_canvas(images, width, height):
    _, h, w, _ = images.shape
    if (w, h) == (width, height):
        return images
    scale = min(width / w, height / h)
    tw, th = max(1, round(w * scale)), max(1, round(h * scale))
    scaled = comfy.utils.common_upscale(images.movedim(-1, 1), tw, th, "lanczos", "disabled")
    left, top = (width - tw) // 2, (height - th) // 2
    return torch.nn.functional.pad(scaled, (left, width - tw - left, top, height - th - top)).movedim(1, -1)


def delivery_dimensions(width, height, scale):
    return max(8, round(int(width * scale) / 8) * 8), max(8, round(int(height * scale) / 8) * 8)


def finish_pass(source, destination, count, width, height, delivery, next_clip=None):
    fps = delivery["fps"]
    multiplier = fps // FPS
    rtx_scale = delivery["rtx_scale"]
    output_width, output_height = delivery_dimensions(width, height, rtx_scale)
    rife = registered("RIFEInterpolation")() if delivery["rife"] else None
    rtx = registered("RTXVideoSuperResolution") if rtx_scale > 1 else None

    def process(images):
        if rife is not None and len(images) > 1:
            images = rife.interpolate(images, FPS, fps, 1.0, batch_size=4)[0]
        elif multiplier != 1:
            images = images.repeat_interleave(multiplier, dim=0)
        return images

    def upscaled(images):
        budget = max(1, min(8, 4000000 // (output_width * output_height)))
        for batch in images.split(budget):
            interrupt()
            if rtx is not None:
                yield rtx.execute(batch.contiguous(), {"resize_type": "scale by multiplier", "scale": rtx_scale},
                                  delivery["rtx_quality"]).args[0]
            else:
                yield batch

    def batches():
        # RIFE needs the first frame of the next batch to interpolate the last interval.
        pending = []
        for frame in frames(source):
            pending.append(frame)
            if len(pending) == 9:
                batch = match_canvas(torch.stack(pending), width, height)
                yield from upscaled(process(batch)[:8 * multiplier])
                pending = pending[-1:]
        if pending:
            batch = match_canvas(torch.stack(pending), width, height)
            if rife is not None and next_clip is not None:
                iterator = frames(next_clip)
                try:
                    next_frame = next(iterator)
                finally:
                    iterator.close()
                batch = torch.cat((batch, match_canvas(next_frame.unsqueeze(0), width, height)))
            yield from upscaled(process(batch)[:len(pending) * multiplier])

    actual = write_video(destination, batches(), output_width, output_height, fps)
    if actual != count * multiplier:
        raise RuntimeError(f"Delivery produced {actual} frames, expected {count * multiplier}")


def concatenate(path, segments):
    if len(segments) == 1:
        clip, wav, _ = segments[0]
        ffmpeg("-i", clip, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
               "-movflags", "+faststart", path)
        return
    def quote(path):
        return "'" + path.resolve().as_posix().replace("'", "'\\''") + "'"

    with tempfile.TemporaryDirectory(prefix=".assemble-", dir=path.parent) as directory:
        video_list = Path(directory) / "video.txt"
        audio_list = Path(directory) / "audio.txt"
        video_list.write_text("".join(f"file {quote(video)}\nduration {count / FPS:.9f}\n"
                                      for video, _, count in segments), encoding="utf-8")
        audio_list.write_text("".join(f"file {quote(wav)}\n" for _, wav, _ in segments), encoding="utf-8")
        ffmpeg("-f", "concat", "-safe", "0", "-i", video_list, "-f", "concat", "-safe", "0", "-i", audio_list,
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
               "-movflags", "+faststart", path)

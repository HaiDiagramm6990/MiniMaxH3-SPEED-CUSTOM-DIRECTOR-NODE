# Hardware benchmarks and validation

Tests used an **NVIDIA RTX 5060 Ti (16 GB)**, **AMD Ryzen 5 5600X** and **32 GB RAM** on Windows. The tested software was ComfyUI 0.43.0 (`bb878b9ee`), frontend 1.57.6, Python 3.13.12, PyTorch 2.12.1+cu130 and SPEED `922eec0`. The tests used local H3 Turbo weights with a hybrid INT8 diffusion checkpoint, a Qwen3-VL NVFP4 text encoder and the full H3 video and audio VAEs. System load, offloading, checkpoint choice, decoder, filesystem and startup state affect these numbers.

## Timing definitions

- **Native sampling** is the time in the SPEED pass, including its stages and GPU completion. The Director records it per pass as `sampling_seconds`.
- **Director render time** includes its own conditioning, sampling, VAE decode, checkpoint writes, delivery and assembly. It excludes upstream loader nodes that finish before the Director runs.
- **Whole queue time** is ComfyUI’s elapsed job time, including upstream model work and any queued export nodes. A warm checkpoint replay can spend most of its time in assembly and storage.

## Development runs

| Run | Measured timing | Notes |
| --- | --- | --- |
| Two approximately 5-second segments | **160.08 s** whole queue | Cold-start development observation. Exact per-pass sampling and preset for this observation were not retained. |
| Three approximately 8-second segments | **473.37 s** whole queue | Development observation. Approximately **98 s** of pure sampling per 8-second segment was recorded separately. Exact dimensions and complete settings for this observation were not retained. |
| 640×640 stock SPEED and Director, 124 frames | **110.03 s** stock and **92.37 s** Director whole queue, **58.54 s** Director sampling | Same isolated server, stock first, with an unload before each. Device-wide VRAM peaks were 15,446 and 15,440 MiB. Ordered trials share filesystem and compiler warm-up. |
| 15-scene recovery | **427.93 s** to resume and export | 4 cached and 12 new passes, 1,685 frames, 70.208 s final film with matching frame clock and an audio/video duration difference of 0.00033 s. |
| One revision in that project | **29.63 s** to regenerate the scene | Two required predecessor passes reused. Subsequent film assembly took 2.04 s with all 16 passes cached. |
| Streamed long assembly | **5.45 s** mux | Stitched 48 existing segments into 5,055 frames at 24 fps, 210.625 s of video and audio. This was a delivery benchmark using prerecorded segments. |

The controlled 640×640 comparison used 24 fps, 124 frames, LCM with a simple schedule, eight steps, CFG 1, denoise 1, video/audio shifts 10/3, Automatic SPEED with four stages, `direct_coarse`, tolerance 0.075, harvest amplitude 21.5819, exponent 0.9276 and seed offset 10000. The stage boundaries were steps 3, 4 and 5. Both outputs had 124 frames. Sampled RGB comparison measured 38.89 dB PSNR and 2.14 mean absolute error on an 8-bit scale. Stereo audio correlation measured 0.9972, with 32 kHz and 48 kHz outputs respectively. The timings describe these runs.

## Live preview

A warm-up preceded four off/on/on/off trials on the same validation process. The same prompt, seed, 320×192 canvas, 39 frames at 24 fps, 8-step LCM and two-stage Manual SPEED schedule `[[3, 0.5], [8, 1.0]]` were used for each. The CPU tiny decoder was the separately installed flat Kijai `taeh3.safetensors`. Enabled settings were 256 px maximum edge, JPEG quality 75, four frames per update and playback at 8 fps. Standalone KJ preview was present in the test graph and produced zero duplicate packets in the Director path.

| Trial | Native sampling | Director render | Sampled device peak | PyTorch sampling allocation peak | JPEG updates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Off A | 72.14 s | 90.74 s | 15,633 MiB | 547 MiB | 0 |
| On A | 101.33 s | 125.48 s | 15,828 MiB | 547 MiB | 8 |
| On B | 127.39 s | 150.82 s | 15,809 MiB | 547 MiB | 8 |
| Off B | 92.89 s | 113.16 s | 15,595 MiB | 547 MiB | 0 |

Enabled runs averaged 114.36 s native sampling and 138.15 s Director render versus 82.52 s and 101.95 s off. The observed changes were 38.6% and 35.5%, with appreciable run-to-run variation. Device-wide peaks include other GPU allocations. All four rendered files had the same SHA-256. A separate 640×640 four-stage Automatic SPEED run emitted eight step updates and eight JPEG updates, and the browser test switched automatically from sampling to the loaded finished film. Preview-setting changes reused the render cache.

## Functional coverage

| Check | Observed result |
| --- | --- |
| All Fantastic modes | Native two-stage SPEED rendered T2VA text, I2VA with a previous-scene tail, FL2VA with two endpoint images, L2VA with a pass endpoint, and REF with a still, clip, paired soundtrack and standalone audio. The combined film was 126 frames with matching 5.25 s audio and video tracks. |
| Regeneration and persistence | A targeted L2VA scene got one replacement checkpoint. Full film render then reused all five. A pre-integration project reopened its saved checkpoint with zero new passes. |
| Cancel and resume | Inference stopped after five committed checkpoints. Resume generated only the missing pass. A Windows atomic-write test recovered from an actual temporary file-sharing block. |
| Continuity and pass timing | A 22-frame opening and 21-frame retained extension confirmed the one-frame trim. The editor exposed independent pass lengths and showed the first-frame thumbnail for uploaded, overridden, linked and cached sources. The extension planner test confirmed it selects the previous pass tail while preserving explicitly assigned first frames. |
| Post-production | A mixed-canvas project reused its generation checkpoints and exported 162 frames at 48 fps and 640×384 with RIFE and 2× RTX. Video and audio both measured 3.375 s. |
| Approval export | The browser sent a selected film and segment to Save Video. Both jobs contained only the file-backed source and Save Video. Audio and video packet hashes matched the source files with default export settings. |

The validated end-to-end generation run reached 70.208 s of finished video. The 210.625 s example above tested assembly. Maximum-length passes at high resolution and other GPU families were outside the test set.

### v1.0.0 release checks

The clean package ran all five modes on the same hardware in 184.43 s. Targeted regeneration produced one new checkpoint and full-film replay reused all five. Cancelling an added pass preserved the five completed checkpoints and resuming generated only the missing pass. A separate 640×640 Automatic SPEED run sampled 22 frames over four stages, emitted eight step events and eight JPEG updates, and completed in 36.70 s on the warm process. The older 22-frame project reopened from its original serialized settings and reused its existing checkpoint. The separate Save Video export contained 148 frames with the extended film’s stereo audio. Thirteen automated schema tests, JavaScript syntax checks, the reference file-drop regression and the install dry run passed. The tested upstream custom-node checkouts were clean.

### v1.1.0 release checks

Browser tests covered autocomplete, direct library assignment, citation changes after reordering and removal, both builders at the caret, and one-step Undo and Redo. A 90-frame Manual SPEED REF render completed with two pictures, a reference video with sound, compound-speaker dialogue, and a timed shot transition. Replaying the same prompt reused the checkpoint. A description edit generated a new checkpoint. The final file contained 90 frames at 24 fps and 3.75 seconds of 48 kHz audio. The existing project schema tests, JavaScript prompt syntax tests, and image-drop regression passed.

# Architecture

| Component | Role |
| --- | --- |
| `project.py` | Validates the versioned timeline, generation modes, media, effective settings, seeds and frame grid. |
| `engine.py` | Plans dependencies, runs passes through ComfyUI’s queue, commits checkpoints and assembles final renders. |
| `native.py` and `fantastic.py` | Connect native H3 conditioning, the installed SPEED runtime and the original Fantastic composer and reference loader. |
| `live_preview.py` | Observes native SPEED’s stage callbacks, samples a bounded video latent and delegates tiny VAE decoding to KJNodes on CPU. |
| `media.py` and `storage.py` | Handle media assembly, frame and audio clocks, delivery processing and atomic storage. |
| `web/` and `routes.py` | Provide the timeline editor, reference library, previews, export approval and project management. |

## Generation and recovery

The Director runs the registered Automatic or Manual SPEED pipeline with H3’s nested audio/video latents. Each pass starts with native conditioning, including endpoint guides or reference media when the selected mode calls for them. The connected H3 model and VAEs perform inference and decode. The bridge to Fantastic loads the composer from the separately installed node package and binds its installed Python builder at runtime.

ComfyUI’s queue owns GPU execution and interruption. The Director writes a pass into a staging directory before committing its manifest, video, preview, waveform, and lossless head and tail frames together. A cancelled or incomplete pass is retried. Completed passes can be reused across later queue jobs and app restarts. Project JSON and render checkpoints are stored under the configured `user/h3_speed_director` directory. Assembled films use the configured output directory.

A pass key includes the effective generation settings and seed, prompts, role, input media bytes, actual continuity sources, relevant model graph and model file identities, relevant runtime identities and explicit regeneration revision. Appending a scene leaves valid earlier keys intact. A changed previous pass can invalidate a next pass that uses its boundary. A hard cut, or an explicitly selected independent image, can break that dependency. Replacements update the active segment list. A focused scene render processes required predecessor scenes and reuses their committed passes when possible.

Delivery keys use the ordered segment identities and delivery settings. A delivery-only change can reassemble from the existing generation checkpoints and reprocess just the delivery artifacts it needs. Preview settings are display options and do not enter generation keys. The **Send to Save Video** action queues the selected render as a file-backed video input to ComfyUI’s Save Video node.

## Prompt editing

The editor uses the installed Fantastic language list, audio-retention markers, composer and validator. During media order edits it tracks each slot by its library asset or continuity source and updates positional citations across affected passes. The updated prompt and conditioning inputs feed the existing generation cache. Project speaker names are editor metadata. Undo and redo record project edits as snapshots.

## Timing and performance

H3 samples at **24 fps** on a `17k + 5` frame grid, up to **362 frames per pass**. Continuity trimming removes the duplicated leading video frame and its corresponding audio samples when applicable. Output delivery derives clip lengths from retained frames, fits stereo waveform duration to the video clock and streams assembly from disk. Sampling and full VAE decode still need working memory for an entire pass.

SPEED invokes its guider once per resolution stage. The optional preview observer reads the stage-local sigma schedule and routes sample telemetry to the editor. It uses the installed KJNodes worker and tiny VAE helpers, with one reduced latent snapshot in flight. The decoder runs on CPU and frame updates can be skipped if its worker is busy. Approval exports run with only the rendered-file source and Save Video in their prompt.

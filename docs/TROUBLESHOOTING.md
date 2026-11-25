# Troubleshooting

| Symptom | What to check |
| --- | --- |
| Director node missing | Restart ComfyUI and read the terminal import log. Confirm the checkout is under an active `custom_nodes` directory, your ComfyUI build includes native H3, and `imageio-ffmpeg` is installed in ComfyUI’s Python environment. |
| SPEED sampler missing or generation fails immediately | Install the linked generic `ComfyUI-SPEED-Sampler` dependency and check its tested revision. Use a compatible native H3 audiovisual model, MiniMax text encoder, 24-channel H3 video VAE and 32-channel H3 audio VAE. |
| Automatic SPEED reports invalid stage boundaries | Very small canvases and short schedules can assign the same step to multiple stages. Select Manual SPEED with distinct **[step, resolution]** pairs, adjust the automatic preset or use a compatible larger canvas. |
| Fantastic modes missing | Install Fantastic and restart. Check its tested revision if the installed prompt compiler does not match the Director’s bridge. Use **Director · existing behavior** for simple prompts or an existing project. |
| An I2VA extension jumps back | Select the extending pass and inspect its **First frame** card. Under **References → This pass**, select **Previous pass’s last frame**. For a new scene, use **Continue previous shot** with I2VA or FL2VA and clear its explicit start image to inherit the preceding tail. |
| Continuity frame is right but motion or sound jumps | A boundary image anchors appearance. Use a compatible prompt and mode, keep **Trim continuous overlap** enabled for duplicates, and review the join. Image conditioning alone does not carry audio or motion state. |
| FPS or duration looks different from the request | H3 snaps pass lengths up to the next supported frame count. An extension adds frames after overlap trimming. A replacement takes the preceding segment’s place. Delivery FPS can differ from H3’s 24 fps sampling clock. |
| Live metrics appear but images are missing | Install KJNodes and its tested `taeh3.safetensors`. Check the model’s `vae_approx` discovery path. Enable live preview before queueing and test with a new pass, since cached passes do not sample. |
| GPU runs out of memory | Start with a smaller canvas or shorter segment, choose a suitable checkpoint for your hardware, and try with live preview and optional delivery processing disabled. The preview decoder is CPU based, but host load and memory pressure still affect total runtime. |
| RIFE or RTX unavailable | Check that the corresponding node loaded in ComfyUI. Set delivery FPS above 24 for RIFE. Use an RTX-capable GPU and the provider’s runtime for RTX processing. |
| Resume rerenders more than expected | Check whether the prompt, seed, model files, overrides, reference media or a predecessor changed. Inspect the cached/generated counts. A cancelled pass only appears after its checkpoint is committed. |

For a reproducible issue, include your ComfyUI and dependency revisions, hardware, mode, sampler settings, canvas size and a sanitized excerpt of the error. Example projects can be reproduced with your own licensed model and media.

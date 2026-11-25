# Installation

## Compatibility

The release was validated with ComfyUI **0.43.0** (`bb878b9ee`), frontend **1.57.6**, Python **3.13.12** and PyTorch **2.12.1+cu130**. Treat that ComfyUI version as the tested baseline. The host must provide native MiniMax H3 audiovisual nodes. Later ComfyUI versions and other hardware may work, subject to the APIs and available memory. The validated target was an RTX 5060 Ti with 16 GB VRAM, 32 GB RAM and offloading enabled. The GPU and system memory required for your clips depend on the checkpoint, canvas and length.

## Install the nodes

1. Locate your ComfyUI installation’s `custom_nodes` directory. In Windows Portable it is the `ComfyUI/custom_nodes` folder inside the standalone package. If your setup has a separate user-configured custom-node directory, use that directory.
2. In that directory run the following. Use one installed copy of each package.

   ```sh
   git clone https://github.com/HaiDiagramm6990/MiniMaxH3-SPEED-CUSTOM-DIRECTOR-NODE.git
   git clone https://github.com/StanLukuvka/ComfyUI-SPEED-Sampler.git
   git clone https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder.git
   ```

   The tested dependency revisions are SPEED [`922eec0`](https://github.com/StanLukuvka/ComfyUI-SPEED-Sampler/commit/922eec0) and Fantastic [`01b6d8d`](https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder/commit/01b6d8d). Fantastic is needed for the five structured modes. The Director’s legacy prompt path also runs with SPEED and native H3 alone.
3. Install the Director’s `requirements.txt` using the **same Python interpreter that runs ComfyUI**. In a manual installation, activate the existing ComfyUI environment and run this from the ComfyUI folder.

   ```sh
   python -m pip install -r custom_nodes/MiniMaxH3-SPEED-CUSTOM-DIRECTOR-NODE/requirements.txt
   ```

   In Windows Portable, run this from the portable package’s root.

   ```powershell
   .\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\MiniMaxH3-SPEED-CUSTOM-DIRECTOR-NODE\requirements.txt
   ```

   PyAV (`av`), PyTorch, NumPy, Pillow and aiohttp use the host’s versions. `imageio-ffmpeg` supplies the FFmpeg executable for delivery. Follow each dependency’s installation instructions for its optional extras. Preserve the working PyTorch/CUDA combination of your ComfyUI environment.

## Install the H3 models

Use the [official native ComfyUI H3 guide](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-native.mdx) and [Comfy-Org model files](https://huggingface.co/Comfy-Org/MiniMax-H3). For external model folders, use ComfyUI’s `extra_model_paths.yaml` and select the resulting entries in the workflow. Check the [MiniMax H3 model terms](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) and obtain the required local-use license where applicable.

| Input | ComfyUI model folder | Select |
| --- | --- | --- |
| `model` | `models/diffusion_models/` | A compatible native H3 AV checkpoint. Match the checkpoint and optional LoRA to the type of generation. Official base workflows use FL2VA weights for text and endpoint-guided shots, and Ref2VA weights for reference generation. |
| `clip` | `models/text_encoders/` | A MiniMax H3 Qwen3-VL text encoder. Set the loader type to `minimax`. |
| `video_vae` | `models/vae/` | The full H3 video VAE with 24 latent channels. |
| `audio_vae` | `models/vae/` | The H3 audio VAE with 32 latent channels. |
| Optional LoRA | `models/loras/` | The LoRA selected by your working H3 workflow. Connect the patched model to the Director. |

The mode selector configures input roles and conditioning. Choose the underlying model and sampler preset yourself, including step count, scheduler and sigma shifts. The included Paper Boat example uses a short **8-step Turbo** schedule for a compatible Turbo model. Match it to your own checkpoint before rendering.

## Optional preview and delivery packages

- **Live Preview** uses [KJNodes](https://github.com/kijai/ComfyUI-KJNodes), tested at `203eb35`, and [Kijai’s flat 2D `taeh3.safetensors`](https://huggingface.co/Kijai/MiniMax-H3-TAE/blob/main/vae_approx/taeh3.safetensors) in `models/vae_approx/`. The tested file has SHA-256 `f0f60fa072089997f817402098c2fd90777cb2660dd79cf5df42fc1e3e08e527`. Keep the full H3 VAE connected for final decoding.
- **RIFE** uses the installed `RIFEInterpolation` node. The tested provider was [ComfyUI-VFI by GACLove](https://github.com/GACLove/ComfyUI-VFI) at `6176a43`. Obtain it and its weights separately from their providers, subject to their terms.
- **RTX upscaling** uses the installed `RTXVideoSuperResolution` node. The tested provider was [ComfyUI Nvidia VFX Nodes](https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes) at `892515e`. Use the provider’s NVIDIA hardware and runtime requirements.

Restart ComfyUI, refresh the browser and load the Paper Boat workflow or add **H3 SPEED Director** from **video → H3 SPEED**. Select your models, click **Open Director**, and follow the [user guide](USER_GUIDE.md) to render, extend, regenerate and approve your first export.

# Direct a film

## First shot

1. Open the Director from its ComfyUI node. Under **Project settings**, choose the canvas, global descriptions and a generation preset that already works with your H3 checkpoint. The supplied example uses a small canvas and a two-stage Manual SPEED schedule for initial checks.
2. Select **Scene 1**. Name the scene, choose the generation mode and enter a prompt. The scene default applies to each pass without its own duration override. Select a pass and edit **Pass duration (seconds)** to give it a different length. The app displays the snapped H3 duration.
3. For image or reference modes, open **References**. Drop your files into the drop zone, then assign them to the correct slots. Use **This pass** to override the scene’s media. The first-frame card identifies uploaded, connected and previously rendered continuity images. A connected `Load Image` node can provide the first project shot’s input.
4. Click **Render / resume film**. Choose the full film, a scene or a segment in **Rendered Video**. Turn on **Live Preview** before queueing if you want to monitor intermediate frames. It shows the current scene, pass, step, sigma and callback wall time. The first step of a stage includes stage setup.

## Choose a mode

| Mode | Inputs and behavior |
| --- | --- |
| **T2VA** | Text and optional structured soundscape. Begins from text conditioning. |
| **I2VA** | First frame and prompt. Use an uploaded still, a connected image for the opening shot, or a continuity frame. |
| **FL2VA** | First and last frames plus prompt. The first frame can come from continuity. Use an explicit last frame except when replacing a pass with a known endpoint. |
| **L2VA** | Last frame plus prompt. A replacement can use the previous take’s endpoint. |
| **REF** | Ordered stills, videos and audio. Tags in the Fantastic editor follow slot order. A video soundtrack can be paired, muted or placed in a standalone audio slot. |

The local Fantastic builder formats structured prompts and adapts the controls and reference requirements. It synchronizes the prompt’s duration to the H3 frame grid. The connected model, sampler, scheduler and sigma shifts remain your generation preset. The **Director · existing behavior** mode opens older projects and supports simple prompts.

## Continue, revise and recover

- **Extend a shot.** Add a pass and choose **Extend the shot**. I2VA and FL2VA extensions use the previous pass’s last frame by default. To use another image, explicitly assign it in **References → This pass**. A replacement uses the existing take’s endpoints when applicable and takes that segment’s place in the edit.
- **Add a scene.** Click **+ Scene**. A hard cut makes the new shot independent. **Continue previous shot** supplies the last frame for first-frame modes when that scene has no explicit start image. In REF the previous tail can be used as a reference. In T2VA and L2VA, the selected mode has no first-frame input.
- **Render incrementally.** Click **Render / resume film** after adding or editing. A valid checkpoint is reused when the inputs match. A changed take can affect following continuity shots. **Resume scene** limits generation to the selected scene and its prerequisites.
- **Regenerate a scene.** Use **Regenerate scene** to generate a new take for the selected scene while preserving valid predecessors. Then render the whole film to update assembly and dependent shots. Change the seed if you want another seeded result.
- **Cancel.** **Cancel render** stops this project’s queue job. Completed passes remain on disk. **Render / resume film** or **Resume scene** can continue later.

## Save, deliver and share

- **Save** stores the project in ComfyUI’s local Director library. **Open** restores it. **Export JSON** makes a portable project file with included library assets where available. **Import JSON** loads it. Model files, graph wiring and rendered checkpoints are separate. Keep the ComfyUI workflow if you want to reproduce the model and node connections.
- Set final output FPS in **Project settings → Delivery**. The project canvas controls frame composition, and shots of different sizes are fitted with padding. Optional RIFE interpolates to a higher rate. With RIFE off the Director repeats frames at higher delivery rates. Optional RTX processing scales video after generation. The film uses synchronized stereo audio.
- Select the finish you approve, then click **Send to Save Video**. The Director uses the connected Save Video node’s filename and encoding choices. If none is connected, it adds and wires one. This queues an export from the existing selected file. The Director also writes assembled films under `output/H3-SpeedDirector/` in the configured ComfyUI output directory.

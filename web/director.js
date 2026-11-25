import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { assetIds, carriesReference, firstFrameSource, generationOf, materializePrompt, mediaFor, referenceSlots, remapAssets, retainsOverlap, settingsFor } from "./fantastic.js";
import { PreviewMonitor } from "./live-preview.js";

const PREFIX = "/h3-speed-director";
const NODE = "H3SpeedDirector";
const APPROVED_VIDEO = "H3SpeedDirectorRenderedVideo";
const $ = (root, selector) => root.querySelector(selector);
const uuid = () => crypto.randomUUID().replaceAll("-", "");
const el = (tag, className, label) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (label != null) element.textContent = label;
    return element;
};
const baseFields = [
    ["width", "Render width", "number", 32], ["height", "Render height", "number", 32],
    ["frames", "Default pass duration (seconds)", "duration"], ["seed", "Seed", "seed"],
    ["steps", "Sampling steps", "number", 1], ["cfg", "CFG", "number", 0.1],
    ["sampler", "Inner sampler", "samplers"], ["scheduler", "Sigma schedule", "schedulers"],
    ["shift_video", "Video sigma shift", "number", 0.01], ["shift_audio", "Audio sigma shift", "number", 0.01],
    ["denoise", "Schedule denoise", "number", 0.01],
    ["speed_mode", "SPEED schedule", ["automatic", "manual"]],
    ["stages", "Automatic stages", [2, 3, 4]], ["noise_policy", "Noise policy", ["direct_coarse", "coupled_full_grid"]],
    ["delta", "Tolerance (Delta)", "number", 0.001], ["amplitude", "Harvest amplitude", "number", 0.0001],
    ["exponent", "Harvest exponent", "number", 0.0001], ["seed_offset", "Transition seed offset", "number", 1],
    ["ratio_mode", "Manual stage units", ["steps", "ratio"]], ["transitions", "Manual stages [goal, scale]", "json"],
    ["trim_overlap", "Trim continuous overlap", "checkbox"],
];
const deliveryFields = [
    ["fps", "Delivery FPS", [24, 48, 72, 96, 120]], ["rife", "Interpolate with RIFE", "checkbox"],
    ["rtx_scale", "RTX upscale factor", "number", 0.05], ["rtx_quality", "RTX quality", ["LOW", "MEDIUM", "HIGH", "ULTRA"]],
];
const activePhases = new Set(["starting", "conditioning", "sampling", "decoding", "saving", "delivery", "assembly", "cached"]);
const phaseLabel = {
    starting: "Checking project", conditioning: "Encoding conditioning", sampling: "Running native SPEED",
    decoding: "Decoding video and audio", saving: "Saving checkpoint", cached: "Reusing checkpoint",
    delivery: "Processing delivery", assembly: "Assembling film", complete: "Render complete",
    interrupted: "Interrupted. Checkpoints are available.", failed: "Render failed",
};

function withDefaults(project, options) {
    return {
        ...project, settings: { ...options.project.settings, ...project.settings },
        delivery: { ...options.project.delivery, ...project.delivery },
        ...(options.live_preview ? { live_preview: { ...options.project.live_preview, ...project.live_preview } } : {}),
        scenes: project.scenes.map(scene => ({
            transition: "cut", references: [], overrides: {}, ...scene,
            passes: scene.passes.map((pass, index) => ({ mode: index ? "extend" : "generate", overrides: {}, ...pass })),
        })),
    };
}

function duration(frames) {
    const seconds = frames / 24;
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s` : `${seconds.toFixed(2)}s`;
}

function snapFrames(frames) {
    return 5 + Math.ceil((Math.min(362, Math.max(5, frames)) - 5) / 17) * 17;
}

function sceneFrames(project, scene) {
    const clips = [];
    for (const pass of scene.passes) {
        const options = settingsFor(project, scene, pass);
        const count = snapFrames(options.frames);
        const continuity = retainsOverlap(scene, pass, clips.at(-1)?.continuity);
        const item = { count: count - (continuity && options.trim_overlap ? 1 : 0), continuity };
        if (pass.mode === "replace" && clips.length) clips.pop();
        clips.push(item);
    }
    return clips.reduce((total, item) => total + item.count, 0);
}

async function request(path, options) {
    const response = await api.fetchApi(PREFIX + path, options);
    if (!response.ok) throw new Error((await response.text()).slice(0, 400) || `Request failed (${response.status})`);
    return response.json();
}

function button(text, handler, className = "") {
    const target = el("button", className, text);
    target.type = "button";
    target.addEventListener("click", handler);
    return target;
}

function inputField(container, label, type, value, change, step) {
    const wrap = el("label", "hsd-field");
    wrap.append(el("span", "", label));
    let input;
    if (Array.isArray(type)) {
        input = el("select");
        type.forEach(option => {
            const [key, text] = Array.isArray(option) ? option : [option, option];
            const item = el("option", "", String(text));
            item.value = key;
            input.append(item);
        });
        input.value = value ?? "";
        input.onchange = () => change(typeof value === "number" ? Number(input.value) : input.value);
    } else {
        input = el(type === "textarea" ? "textarea" : "input");
        if (type !== "textarea") input.type = type === "duration" ? "number" : ["seed", "json"].includes(type) ? "text" : type;
        if (type === "number") input.step = step ?? "any";
        if (type === "duration") {
            input.step = "0.001";
            input.min = String(5 / 24);
            input.max = String(362 / 24);
            input.title = "H3 snaps this duration up to its 17k + 5 frame grid at 24 fps.";
        }
        if (type === "seed") input.inputMode = "numeric";
        if (type === "checkbox") input.checked = Boolean(value);
        else if (type === "json") input.value = JSON.stringify(value);
        else if (type === "duration") input.value = (value / 24).toFixed(3);
        else input.value = value ?? "";
        const event = type === "text" || type === "textarea" || type === "seed" ? "input" : "change";
        input.addEventListener(event, () => {
            if (type === "json") {
                try {
                    const parsed = JSON.parse(input.value);
                    input.setCustomValidity("");
                    change(parsed);
                } catch {
                    input.setCustomValidity("Enter a JSON array of stage pairs.");
                    input.reportValidity();
                }
            } else if (type === "checkbox") change(input.checked);
            else if (type === "number" || type === "duration") {
                if (input.value === "") return;
                change(type === "duration" ? Math.min(362, Math.max(5, Math.round(Number(input.value) * 24))) : Number(input.value));
            } else change(input.value);
        });
    }
    wrap.append(input);
    container.append(wrap);
    return input;
}

class Editor {
    constructor(node, widget, options, project) {
        this.node = node;
        this.widget = widget;
        this.options = options;
        this.assets = [];
        this.status = {};
        this.active = project.scenes[0].id;
        this.pass = project.scenes[0].passes[0].id;
        this.project = project;
        this.tab = "scene";
        this.assetScope = "scene";
        this.previewToken = null;
        this.dialog = el("dialog", "hsd");
        this.dialog.innerHTML = `
            <header class="hsd-header">
                <div><div class="hsd-brand">H3 SPEED DIRECTOR</div><h1 data-title></h1></div>
                <nav class="hsd-toolbar" aria-label="Project files" data-toolbar></nav>
            </header>
            <section class="hsd-timeline-panel" aria-label="Scene timeline">
                <div class="hsd-sectionbar"><h2>Timeline</h2><output data-duration></output><div class="hsd-spacer"></div><div class="hsd-actions" data-scene-actions></div></div>
                <div class="hsd-timeline" data-timeline></div>
            </section>
            <main class="hsd-workspace">
                <section class="hsd-inspector" aria-label="Director settings">
                    <div class="hsd-tabs" data-tabs></div>
                    <div class="hsd-scroll" data-inspector></div>
                </section>
                <section class="hsd-monitor" aria-label="Video preview">
                    <div class="hsd-sectionbar hsd-monitor-header">
                        <div class="hsd-actions" aria-label="Preview views">
                            <button type="button" data-rendered-tab>Rendered Video</button>
                            <button type="button" data-live-tab>Live Preview</button>
                        </div>
                        <div class="hsd-spacer"></div><select data-preview-select aria-label="Preview source"></select>
                    </div>
                    <div class="hsd-rendered-panel" data-rendered-panel>
                        <div class="hsd-preview"><video controls playsinline hidden></video><div class="hsd-empty" data-preview-empty>No rendered preview</div></div>
                        <div class="hsd-monitor-caption"><div data-monitor-caption></div><div data-approve-preview></div></div>
                    </div>
                    <div class="hsd-live-panel" data-live-panel hidden>
                        <div data-live-options></div>
                        <div class="hsd-preview"><canvas data-live-canvas aria-label="Live sampling frames" hidden></canvas><div class="hsd-empty" data-live-empty></div></div>
                        <div class="hsd-live-metrics" data-live-metrics></div>
                        <div class="hsd-live-charts">
                            <div class="hsd-live-chart" data-sigma-chart></div><div class="hsd-live-chart" data-time-chart></div>
                        </div>
                    </div>
                </section>
            </main>
            <footer class="hsd-footer">
                <div class="hsd-render-info"><span data-status role="status"></span><progress max="1" value="0"></progress></div>
                <div class="hsd-actions" data-render-actions></div>
            </footer>`;
        const toolbar = $(this.dialog, "[data-toolbar]");
        toolbar.append(button("New", () => this.perform(() => this.newProject())),
            button("Open", () => this.perform(() => this.openProject())),
            button("Save", () => this.perform(() => this.saveProject())),
            button("Import JSON", () => this.chooseImport()),
            button("Export JSON", () => this.perform(() => this.exportProject())),
            button("Close", () => this.dialog.close(), "hsd-close"));
        const sceneActions = $(this.dialog, "[data-scene-actions]");
        sceneActions.append(button("+ Scene", () => this.addScene()), button("Duplicate", () => this.duplicate()),
            button("Move left", () => this.move(-1)), button("Move right", () => this.move(1)),
            button("Delete", () => this.removeScene()));
        const tabs = $(this.dialog, "[data-tabs]");
        for (const [id, label] of [["scene", "Scene"], ["project", "Project settings"], ["assets", "References"]]) {
            const tab = button(label, () => { this.tab = id; this.renderInspector(); });
            tab.dataset.tab = id;
            tabs.append(tab);
        }
        this.queueButton = button("Render / resume film", () => this.perform(() => this.queue()), "hsd-primary");
        this.resumeButton = button("Resume scene", () => this.perform(() => this.queue("resume")));
        this.redoButton = button("Regenerate scene", () => this.perform(() => this.queue("regenerate")));
        this.cancelButton = button("Cancel render", () => this.perform(() => this.cancel()));
        this.saveVideoButton = button("Send to Save Video", () => this.perform(() => this.savePreview()));
        $(this.dialog, "[data-approve-preview]").append(this.saveVideoButton);
        $(this.dialog, "[data-render-actions]").append(this.cancelButton, this.resumeButton, this.redoButton, this.queueButton);
        $(this.dialog, "[data-preview-select]").onchange = event => this.showPreview(event.target.value);
        this.monitor = new PreviewMonitor(this.dialog);
        this.renderLiveSettings();
        this.onLive = ({ detail }) => {
            if (detail?.project === this.project.id) this.monitor.receive(detail);
        };
        this.onDirectorProgress = ({ detail }) => {
            if (detail?.project === this.project.id && ["complete", "interrupted", "failed"].includes(detail.phase)) {
                this.refresh().catch(() => {});
            }
        };
        this.onStep = event => {
            const data = event.detail;
            if (data?.prompt_id === this.status.prompt_id && this.status.phase === "sampling" && data.max) {
                this.fractional = data.value / data.max;
                this.renderProgress();
            }
        };
        api.addEventListener("progress", this.onStep);
        api.addEventListener("h3-speed-director.live", this.onLive);
        api.addEventListener("h3-speed-director.progress", this.onDirectorProgress);
        this.dialog.addEventListener("close", () => this.dispose());
        document.body.append(this.dialog);
        this.commit();
        this.render();
        this.dialog.showModal();
        this.timer = setInterval(() => this.refresh().catch(() => {}), 1500);
        this.refresh().catch(error => this.notice(error.message));
    }

    get scene() { return this.project.scenes.find(scene => scene.id === this.active); }
    get activePass() { return this.scene.passes.find(pass => pass.id === this.pass) ?? this.scene.passes[0]; }

    dispose() {
        clearInterval(this.timer);
        this.monitor.clear();
        api.removeEventListener("progress", this.onStep);
        api.removeEventListener("h3-speed-director.live", this.onLive);
        api.removeEventListener("h3-speed-director.progress", this.onDirectorProgress);
        this.dialog.remove();
        delete this.node.h3Editor;
    }

    async perform(task) {
        try { await task(); } catch (error) { this.notice(error.message || String(error), true); }
    }

    notice(message, error = false) {
        this.message = message;
        const status = $(this.dialog, "[data-status]");
        status.textContent = message;
        status.classList.toggle("hsd-error", error);
    }

    commit() {
        if (this.options.compiler) {
            for (const scene of this.project.scenes) for (const pass of scene.passes) {
                materializePrompt(this.options.compiler, this.project, scene, pass);
            }
        }
        this.widget.value = JSON.stringify(this.project);
        this.node.graph?.setDirtyCanvas(true, true);
    }

    mutate(refresh = false) {
        this.commit();
        this.renderTimeline();
        if (refresh) this.renderInspector();
    }

    select(id) {
        this.active = id;
        this.pass = this.scene.passes[0].id;
        this.previewToken = null;
        this.tab = "scene";
        this.render();
    }

    addScene() {
        const scene = { id: uuid(), title: `Scene ${this.project.scenes.length + 1}`, transition: "cut",
            references: [], overrides: {}, passes: [{ id: uuid(), mode: "generate", prompt: "", overrides: {} }] };
        this.project.scenes.push(scene);
        this.commit();
        this.select(scene.id);
    }

    duplicate() {
        const scene = structuredClone(this.scene);
        scene.id = uuid();
        scene.title = `${scene.title} copy`;
        scene.passes.forEach(pass => { pass.id = uuid(); });
        this.project.scenes.splice(this.project.scenes.indexOf(this.scene) + 1, 0, scene);
        this.commit();
        this.select(scene.id);
    }

    removeScene() {
        if (this.project.scenes.length < 2) return this.notice("A project needs one scene.");
        const index = this.project.scenes.indexOf(this.scene);
        this.project.scenes.splice(index, 1);
        this.normalizeOpening();
        this.commit();
        this.select(this.project.scenes[Math.min(index, this.project.scenes.length - 1)].id);
    }

    normalizeOpening() {
        const first = this.project.scenes[0];
        if (first.transition === "continuous" || (first.transition === "reference" && first.previous_reference &&
            !first.references.length && !first.videos?.length && !first.audios?.length)) {
            first.transition = "cut";
        }
        first.previous_reference = false;
    }

    move(change) {
        const index = this.project.scenes.indexOf(this.scene);
        this.reorder(this.active, index + change);
    }

    reorder(id, to) {
        const from = this.project.scenes.findIndex(scene => scene.id === id);
        if (from < 0 || to < 0 || to >= this.project.scenes.length || from === to) return;
        const [scene] = this.project.scenes.splice(from, 1);
        this.project.scenes.splice(to, 0, scene);
        this.normalizeOpening();
        this.commit();
        this.select(id);
    }

    render() {
        this.renderTimeline();
        this.renderInspector();
        this.renderPreview();
        this.renderProgress();
    }

    renderTimeline() {
        const timeline = $(this.dialog, "[data-timeline]");
        const scroll = timeline.scrollLeft;
        timeline.replaceChildren();
        $(this.dialog, "[data-title]").textContent = this.project.name || "Untitled film";
        let cursor = 0;
        this.project.scenes.forEach((scene, index) => {
            const frames = sceneFrames(this.project, scene);
            const card = button("", () => this.select(scene.id), "hsd-clip");
            card.draggable = true;
            card.setAttribute("aria-pressed", String(this.active === scene.id));
            card.style.setProperty("--clip-width", `${Math.min(420, Math.max(136, 100 + frames * 0.42))}px`);
            const strip = el("div", "hsd-clip-image");
            const thumbnail = this.status.scenes?.[scene.id]?.passes?.[0]?.token;
            if (thumbnail) {
                const image = el("img");
                image.alt = "";
                image.src = this.media(thumbnail, "thumbnail");
                image.draggable = false;
                strip.append(image);
            } else {
                strip.append(el("span", "hsd-clip-icon", scene.transition === "continuous" ? "↪" : scene.transition === "reference" ? "◇" : "▱"));
            }
            strip.append(el("span", "hsd-seam", scene.transition));
            card.append(strip, el("strong", "", scene.title || "Untitled scene"),
                el("span", "hsd-clip-time", `${duration(cursor)} · ${duration(frames)}`));
            card.ondragstart = event => { event.dataTransfer.setData("text/plain", scene.id); event.dataTransfer.effectAllowed = "move"; };
            card.ondragover = event => { event.preventDefault(); card.classList.add("hsd-drop"); };
            card.ondragleave = () => card.classList.remove("hsd-drop");
            card.ondrop = event => { event.preventDefault(); this.reorder(event.dataTransfer.getData("text/plain"), index); };
            timeline.append(card);
            cursor += frames;
        });
        timeline.scrollLeft = scroll;
        $(this.dialog, "[data-duration]").textContent = `${duration(cursor)} · ${this.project.scenes.length} scene${this.project.scenes.length === 1 ? "" : "s"}`;
    }

    controls(container, object, descriptors) {
        for (const [key, title, type, step] of descriptors) {
            inputField(container, title, this.options[type] ?? type, object[key], value => {
                object[key] = value;
                this.mutate();
            }, step);
        }
    }

    overrides(section, object, inherited) {
        const fields = baseFields.filter(([key]) => key !== "frames");
        const overridden = fields.filter(([key]) => key in object);
        const details = el("details", "hsd-details");
        details.append(el("summary", "", `Parameter overrides · ${overridden.length}`));
        const grid = el("div", "hsd-grid");
        for (const field of overridden) {
            const cell = el("div", "hsd-override");
            this.controls(cell, object, [field]);
            const remove = button("×", () => { delete object[field[0]]; this.mutate(true); });
            remove.setAttribute("aria-label", `Clear ${field[1]} override`);
            cell.append(remove);
            grid.append(cell);
        }
        details.append(grid);
        const choices = [["", "Add parameter override…"], ...fields.filter(([key]) => !(key in object)).map(([id, title]) => [id, title])];
        const select = inputField(details, "Inherit from parent until overridden", choices, "", value => {
            if (!value) return;
            object[value] = structuredClone(inherited[value]);
            this.mutate(true);
        });
        select.disabled = choices.length === 1;
        details.open = overridden.length > 0;
        section.append(details);
    }

    passDuration(container, label, overrides, inheritedFrames, resetLabel) {
        const panel = el("div", "hsd-duration-control");
        const frames = overrides.frames ?? inheritedFrames;
        inputField(panel, label, "duration", frames, value => {
            overrides.frames = value;
            this.mutate(true);
        });
        const info = el("div", "hsd-duration-info");
        const reset = button(resetLabel, () => { delete overrides.frames; this.mutate(true); });
        reset.hidden = overrides.frames === undefined;
        info.append(el("span", "hsd-note", `Renders ${duration(snapFrames(frames))}`), reset);
        panel.append(info);
        container.append(panel);
    }

    renderInspector() {
        this.dialog.querySelectorAll("[data-tab]").forEach(tab => tab.setAttribute("aria-pressed", String(tab.dataset.tab === this.tab)));
        const inspector = $(this.dialog, "[data-inspector]");
        const scroll = inspector.scrollTop;
        inspector.replaceChildren();
        if (this.tab === "project") this.projectInspector(inspector);
        else if (this.tab === "assets") this.assetInspector(inspector);
        else this.sceneInspector(inspector);
        inspector.scrollTop = scroll;
    }

    projectInspector(inspector) {
        inputField(inspector, "Project name", "text", this.project.name, value => { this.project.name = value; this.mutate(); });
        const global = el("div", "hsd-grid hsd-global");
        for (const [key, label] of [["character", "Characters"], ["environment", "Environment"], ["style", "Visual style"]]) {
            inputField(global, label, "textarea", this.project[key], value => { this.project[key] = value; this.commit(); });
        }
        inspector.append(global, el("h3", "", "Generation defaults"));
        const grid = el("div", "hsd-grid");
        this.controls(grid, this.project.settings, baseFields);
        inspector.append(grid, el("h3", "", "Delivery"));
        const delivery = el("div", "hsd-grid");
        this.controls(delivery, this.project.delivery, deliveryFields);
        inspector.append(delivery, el("p", "hsd-note", "H3 generates at 24 fps. Delivery uses the project canvas. Scene sizes are fitted with padding. Higher delivery rates repeat frames when RIFE is off."));
    }

    sceneInspector(inspector) {
        const scene = this.scene;
        const options = { ...this.project.settings, ...scene.overrides };
        const overview = el("div", "hsd-grid");
        inputField(overview, "Scene name", "text", scene.title, value => { scene.title = value; this.mutate(); });
        const modes = this.generationChoices();
        if (modes.length > 1 || scene.generation) {
            inputField(overview, "Scene generation mode", modes, scene.generation ?? "legacy", value => {
                scene.generation = value;
                this.mutate(true);
            });
        }
        const continuation = this.project.scenes[0] !== scene;
        const choices = [["cut", "Hard cut"], ...(continuation ? [["continuous", "Continue previous shot"]] : []),
            ["reference", "Reference transition"]];
        inputField(overview, "Transition into scene", choices, scene.transition, value => {
            scene.transition = value;
            if (value === "continuous" && generationOf(scene, scene.passes[0]) === "legacy") scene.first_frame = null;
            if (value !== "reference") scene.previous_reference = false;
            this.mutate(true);
        });
        this.passDuration(overview, "Scene default per pass (seconds)", scene.overrides, this.project.settings.frames, "Use project default");
        if (scene.transition === "reference" && continuation) {
            inputField(overview, "Use previous tail as <Picture 1>", "checkbox", scene.previous_reference,
                value => { scene.previous_reference = value; this.mutate(true); });
        }
        inspector.append(overview);
        this.addFirstFramePreview(inspector);
        const opening = generationOf(scene, scene.passes[0]);
        if (scene.transition !== "cut" && ["T2VA", "L2VA"].includes(opening)) {
            inspector.append(el("p", "hsd-note", `${opening} starts without a first-frame anchor.`));
        } else if (scene.transition === "continuous" && opening === "REF") {
            inspector.append(el("p", "hsd-note", "REF uses the previous scene tail as <Picture 1>."));
        }
        this.overrides(inspector, scene.overrides, this.project.settings);
        const refLink = button("Manage scene references", () => { this.tab = "assets"; this.renderInspector(); });
        inspector.append(refLink);

        const header = el("div", "hsd-sectionbar hsd-pass-header");
        header.append(el("h3", "", "Generation passes"), el("div", "hsd-spacer"),
            button("+ Pass", () => {
                const pass = { id: uuid(), mode: "extend", prompt: "", overrides: {} };
                scene.passes.push(pass);
                this.pass = pass.id;
                this.mutate(true);
            }));
        inspector.append(header);
        const track = el("div", "hsd-pass-track");
        scene.passes.forEach((pass, index) => {
            const length = duration(snapFrames(pass.overrides.frames ?? options.frames));
            const pill = button(`${index + 1} · ${pass.mode} · ${length}`, () => { this.pass = pass.id; this.renderInspector(); });
            pill.setAttribute("aria-pressed", String(this.activePass === pass));
            track.append(pill);
        });
        inspector.append(track);
        const pass = this.activePass;
        this.passDuration(inspector, "Pass duration (seconds)", pass.overrides, options.frames, "Use scene default");
        if (modes.length > 1 || pass.generation) {
            inputField(inspector, "Pass generation mode", [["", "Inherit scene mode"], ...modes], pass.generation ?? "", value => {
                if (value) pass.generation = value;
                else delete pass.generation;
                this.mutate(true);
            });
        }
        if (scene.passes[0] !== pass) {
            const row = el("div", "hsd-grid");
            inputField(row, "Pass role", [["extend", "Extend the shot"], ["replace", "Replace preceding pass"]], pass.mode,
                value => { pass.mode = value; this.mutate(true); });
            row.append(button("Delete pass", () => {
                scene.passes.splice(scene.passes.indexOf(pass), 1);
                this.pass = scene.passes[0].id;
                this.mutate(true);
            }));
            inspector.append(row);
        }
        if (generationOf(scene, pass) === "legacy") {
            inputField(inspector, "Pass prompt", "textarea", pass.prompt, value => { pass.prompt = value; this.commit(); });
            if (this.options.fantasticError) inspector.append(el("p", "hsd-note", this.options.fantasticError));
        } else if (this.options.compiler) {
            this.structuredPrompt(inspector, scene, pass);
        } else {
            inspector.append(el("p", "hsd-error", this.options.fantasticError || "Fantastic PromptBuilder is unavailable."),
                el("pre", "hsd-built-prompt", pass.compiled_prompt || ""));
        }
        inputField(inspector, "Negative prompt · CFG above 1", "textarea", pass.negative, value => { pass.negative = value; this.commit(); });
        this.overrides(inspector, pass.overrides, options);
    }

    addFirstFramePreview(inspector) {
        const card = el("div", "hsd-first-frame");
        card.dataset.firstFramePreview = "";
        inspector.append(card);
        this.updateFirstFramePreview(card);
    }

    updateFirstFramePreview(card = $(this.dialog, "[data-first-frame-preview]")) {
        if (!card) return;
        const scene = this.scene;
        const pass = this.activePass;
        const index = scene.passes.indexOf(pass);
        const firstSlot = this.node.findInputSlot("first_frame");
        const linked = index === 0 && this.project.scenes[0] === scene && this.node.inputs?.[firstSlot]?.link != null;
        const source = firstFrameSource(scene, pass, linked);
        card.hidden = !source;
        if (!source) return;

        let name = "No first frame selected";
        let description = "Choose an image in References.";
        let url = null;
        if (source.kind === "asset") {
            name = this.assets.find(asset => asset.id === source.asset)?.name ?? "Selected library image";
            description = source.override ? "This pass’s image" : "Scene default";
            url = api.apiURL(PREFIX + "/assets/" + source.asset);
        } else if (source.kind === "graph") {
            const upstream = this.node.getInputNode(firstSlot);
            name = upstream?.title || "Connected first frame";
            description = "ComfyUI graph input";
            const selected = (upstream?.comfyClass ?? upstream?.type) === "LoadImage"
                ? upstream.widgets?.find(widget => widget.name === "image")?.value : null;
            if (typeof selected === "string" && selected) {
                const tag = selected.match(/ \[(input|output|temp)\]$/);
                const filepath = (tag ? selected.slice(0, tag.index) : selected).replaceAll("\\", "/");
                const parts = filepath.split("/");
                const filename = parts.pop();
                name = filename;
                url = api.apiURL("/view?" + new URLSearchParams({ filename, subfolder: parts.join("/"), type: tag?.[1] ?? "input" }));
            } else {
                description = "The connected node supplies the first frame when the workflow runs.";
            }
        } else if (source.kind !== "missing") {
            let token;
            const side = source.kind === "pass-head" ? "head" : "tail";
            if (source.kind === "scene-tail") {
                const previous = this.project.scenes[this.project.scenes.indexOf(scene) - 1];
                name = `Previous scene’s last frame${previous ? ` · ${previous.title}` : ""}`;
                token = this.status.scenes?.[previous?.id]?.passes?.at(-1)?.token;
            } else {
                name = `Previous pass’s ${side === "head" ? "first" : "last"} frame`;
                token = this.status.scenes?.[scene.id]?.takes?.[scene.passes[index - 1]?.id];
            }
            if (token && this.options.boundary_thumbnails) url = this.media(token, side);
            description = url ? "Continuity frame from the last render" : "Preview available after the source renders.";
        }

        const signature = JSON.stringify([name, description, url]);
        if (signature === card.dataset.signature) return;
        card.dataset.signature = signature;
        const text = el("div", "hsd-first-frame-label");
        const detail = el("span", "hsd-note", description);
        text.append(el("strong", "", "First frame"), el("span", "", name), detail);
        card.replaceChildren(text);
        if (url) {
            const image = el("img");
            image.alt = "Current first frame";
            image.src = url;
            image.onerror = () => { image.hidden = true; detail.textContent = "Image preview unavailable."; };
            card.prepend(image);
        }
        if (this.tab === "scene") text.append(button("Manage first frame", () => {
            this.assetScope = "pass";
            this.tab = "assets";
            this.renderInspector();
        }));
    }

    generationChoices() {
        return [["legacy", "Director · existing behavior"], ...(this.options.compiler?.MODES ?? []).map(
            mode => [mode.id, `${mode.id} · ${mode.hint}`],
        )];
    }

    structuredPrompt(inspector, scene, pass) {
        const composer = this.options.compiler;
        const mode = generationOf(scene, pass);
        materializePrompt(composer, this.project, scene, pass);
        const state = pass.builder;
        const section = el("section", "hsd-prompt-builder");
        const output = el("pre", "hsd-built-prompt");
        const issues = el("ul", "hsd-prompt-issues");
        const timing = el("p", "hsd-note");
        const graphImage = this.project.scenes[0] === scene && scene.passes[0] === pass &&
            this.node.inputs?.some(input => input.name === "first_frame" && input.link != null);
        const update = () => {
            const generated = materializePrompt(composer, this.project, scene, pass);
            this.commit();
            output.textContent = pass.compiled_prompt;
            timing.textContent = `${Math.round(generated.duration * 24)} frames at 24 fps`;
            const slots = referenceSlots(composer, scene, pass, this.assets, graphImage);
            issues.replaceChildren(...composer.validate(generated, slots).map(issue =>
                el("li", issue.level === "error" ? "hsd-error" : "", issue.msg)));
        };
        const field = (mount, owner, key, label, type = "textarea") =>
            inputField(mount, label, type, owner[key], value => { owner[key] = value; update(); });
        const optional = (mount, name, label) => inputField(mount, `Include ${label}`, "checkbox", !state.off?.[name], value => {
            (state.off ??= {})[name] = !value;
            update();
        });
        section.append(el("h3", "", "Fantastic prompt builder"), timing);
        if (mode === "REF") {
            const ref = state.ref;
            const types = el("div", "hsd-grid");
            for (const task of composer.TASK_TYPES) inputField(types, task, "checkbox", ref.summaryTypes.includes(task), enabled => {
                ref.summaryTypes = enabled ? [...ref.summaryTypes, task] : ref.summaryTypes.filter(value => value !== task);
                update();
            });
            section.append(types);
            field(section, ref, "summaryText", "Summary");
            field(section, ref, "styleLine", "Style opening", "text");
            field(section, ref, "detail", "Detailed description");
            for (const [key, label, heading] of [["subjectDefs", "subject definitions", "Subject definitions"], ["retention", "retention analysis", "Retention analysis"]]) {
                const details = el("details", "hsd-details");
                details.append(el("summary", "", heading));
                details.open = ref[key].length > 0;
                optional(details, key === "subjectDefs" ? "subject_definitions" : "retention_analysis", label);
                ref[key].forEach((entry, index) => {
                    const row = el("div", "hsd-fantastic-row");
                    if (key === "subjectDefs") {
                        field(row, entry, "text", "Definition");
                        field(row, entry, "name", "Subject name", "text");
                        field(row, entry, "voice", "Voice description", "text");
                    } else {
                        field(row, entry, "label", "Reference tag", "text");
                        field(row, entry, "context", "Context", "text");
                        field(row, entry, "marker", "Retention", [...new Set([...composer.VISUAL_MARKERS, ...composer.AUDIO_MARKERS])]);
                        field(row, entry, "note", "Retention note");
                    }
                    inputField(row, "Include row", "checkbox", !entry.off, enabled => { entry.off = !enabled; update(); });
                    row.append(button("Remove row", () => { ref[key].splice(index, 1); this.mutate(true); }));
                    details.append(row);
                });
                details.append(button(key === "subjectDefs" ? "+ Definition" : "+ Retention entry", () => {
                    ref[key].push(key === "subjectDefs" ? { text: "", name: "", voice: "" } :
                        { label: "", context: "", marker: composer.VISUAL_MARKERS[0], note: "" });
                    this.mutate(true);
                }));
                section.append(details);
            }
        } else {
            field(section, state, "imd", "Integrated multimodal description");
            if (mode === "FL2VA" || mode === "L2VA") field(section, state, mode === "FL2VA" ? "p2Shot" : "lastShot", "Ending shot number", "number");
        }
        const sound = mode === "REF" ? state.ref : state;
        optional(section, "overall_soundscape", "soundscape");
        field(section, sound, "soundscape", "Soundscape");
        optional(section, "non_diegetic_music", "music");
        field(section, sound, "music", "Music");
        const preview = el("details", "hsd-details");
        preview.append(el("summary", "", "Compiled prompt and guidance"), output, issues);
        section.append(preview);
        inspector.append(section);
        update();
    }

    assetInspector(inspector) {
        const scene = this.scene;
        const pass = this.activePass;
        const generation = generationOf(scene, pass);
        const compiler = this.options.compiler;
        const capacity = compiler?.MODE_CAPACITY[generation];
        inspector.append(el("h3", "", `References for ${scene.title}`));
        if (generation === "T2VA") {
            inspector.append(el("p", "hsd-note", "T2VA uses the prompt without reference media."));
            return;
        }
        if (generation !== "legacy" && !capacity) {
            inspector.append(el("p", "hsd-error", "The installed Fantastic PromptBuilder is unavailable."));
            return;
        }
        if (generation !== "legacy") {
            inputField(inspector, "Apply reference changes to", [["scene", "Scene defaults"], ["pass", "This pass"]], this.assetScope,
                value => { this.assetScope = value; this.renderInspector(); });
            if (this.assetScope === "pass" && pass.media) {
                inspector.append(button("Use scene media defaults", () => { delete pass.media; this.mutate(true); }));
            }
        }
        const perPass = generation !== "legacy" && this.assetScope === "pass";
        const current = perPass ? mediaFor(scene, pass) : scene;
        const updateMedia = (name, value) => {
            if (perPass) (pass.media ??= {})[name] = value;
            else scene[name] = value;
            this.mutate(true);
        };

        const upload = el("input", "hsd-file");
        upload.type = "file";
        upload.accept = "image/png,image/jpeg,image/webp" + (generation === "REF" ? ",.mp4,.mov,.mkv,.webm,.wav,.mp3,.flac,.m4a,.ogg" : "");
        upload.multiple = true;
        upload.onchange = () => {
            const files = Array.from(upload.files);
            upload.value = "";
            this.addImages(files);
        };
        const dropZone = button(generation === "REF" ? "Drop images, video or audio here or browse" : "Drop images here or browse",
            () => upload.click(), "hsd-image-drop");
        dropZone.ondragover = event => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
            dropZone.classList.add("hsd-drop");
        };
        dropZone.ondragleave = () => dropZone.classList.remove("hsd-drop");
        dropZone.ondrop = event => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
            dropZone.classList.remove("hsd-drop");
            this.addImages(Array.from(event.dataTransfer.files));
        };
        inspector.append(dropZone, upload);
        const options = kind => this.assets.filter(asset => (asset.kind ?? "image") === kind).map(asset => [asset.id, asset.name]);
        const automatic = generation === "legacy" ? "None" : "Automatic";
        const imageOptions = options("image");
        const images = [["", automatic], ...imageOptions];
        const roles = Object.values(capacity?.roles ?? {});
        if ((generation === "legacy" && scene.transition !== "continuous") || roles.includes("first frame")) {
            const fallback = perPass && pass.mode === "extend" ? "Previous pass’s last frame" : automatic;
            inputField(inspector, "First frame", [["", fallback], ...imageOptions], current.first_frame ?? "",
                value => updateMedia("first_frame", value || null));
            if (generation !== "legacy") this.addFirstFramePreview(inspector);
        }
        if (generation === "legacy" || roles.includes("last frame")) {
            inputField(inspector, "Last frame", images, current.last_frame ?? "", value => updateMedia("last_frame", value || null));
            if (generation !== "legacy") inspector.append(el("p", "hsd-note", "A last frame is required. Replacement passes can reuse the prior endpoint."));
        }
        if (generation !== "legacy" && generation !== "REF") return;

        const pictures = current.references ?? [];
        const prependTail = generation === "REF" ? carriesReference(scene, pass) : scene.transition === "reference" && scene.previous_reference;
        if (prependTail) inspector.append(el("p", "hsd-note", "The previous scene’s last frame is <Picture 1>."));
        const list = el("div", "hsd-assets");
        pictures.forEach((id, index) => {
            const name = this.assets.find(asset => asset.id === id)?.name || "Missing asset";
            const row = el("div", "hsd-asset");
            const image = el("img");
            image.alt = "";
            image.src = api.apiURL(PREFIX + "/assets/" + id);
            row.append(image, el("span", "", `<Picture ${index + 1 + Number(prependTail)}> · ${name}`),
                button("↑", () => {
                    if (!index) return;
                    const sequence = pictures.slice();
                    [sequence[index - 1], sequence[index]] = [sequence[index], sequence[index - 1]];
                    updateMedia("references", sequence);
                }), button("Remove", () => updateMedia("references", pictures.filter((_, i) => i !== index))));
            list.append(row);
        });
        inspector.append(list);
        inputField(inspector, "Add visual reference", [["", "Choose from the library"], ...options("image")], "", value => {
            if (!value) return;
            if (pictures.length + Number(prependTail) >= (capacity?.Picture ?? 9)) {
                return this.notice("MiniMax H3 supports nine reference images.");
            }
            updateMedia("references", [...pictures, value]);
        });
        if (generation === "legacy") {
            inspector.append(el("p", "hsd-note", "First and last images anchor the shot. Ordered references use the <Picture n> tags in each pass prompt."));
            return;
        }
        for (const [key, kind, count] of [["videos", "video", capacity.Video], ["audios", "audio", capacity.Audio]]) {
            const entries = current[key] ?? [];
            entries.forEach((entry, index) => {
                const id = key === "videos" ? entry.asset : entry;
                const asset = this.assets.find(item => item.id === id);
                const row = el("div", "hsd-asset");
                row.append(el("span", "", `${kind === "video" ? `<Video ${index + 1}>` : "Standalone audio"} · ${asset?.name ?? "Missing asset"}`));
                if (kind === "video" && asset?.has_audio) {
                    inputField(row, "Soundtrack", [["paired", "Pair with video"], ["off", "Mute"], ["standalone", "Separate audio reference"]],
                        entry.audio_mode ?? "paired", value => updateMedia(key, entries.map((item, i) => i === index ? { ...item, audio_mode: value } : item)));
                }
                row.append(button("↑", () => {
                    if (!index) return;
                    const sequence = entries.slice();
                    [sequence[index - 1], sequence[index]] = [sequence[index], sequence[index - 1]];
                    updateMedia(key, sequence);
                }), button("Remove", () => updateMedia(key, entries.filter((_, i) => i !== index))));
                inspector.append(row);
            });
            inputField(inspector, `Add reference ${kind}`, [["", "Choose from the library"], ...options(kind)], "", value => {
                if (!value) return;
                if (entries.length >= count) return this.notice(`Fantastic supports up to ${count} ${kind} slots.`, true);
                updateMedia(key, [...entries, kind === "video" ? { asset: value, audio_mode: "paired" } : value]);
            });
        }
        inputField(inspector, "Reference image size", [["match", "Match generation canvas"], ["max", "Maximum native detail"]],
            current.ref_image_size ?? "match", value => updateMedia("ref_image_size", value));
        const slots = referenceSlots(compiler, scene, pass, this.assets, false);
        if (slots.length) inspector.append(el("p", "hsd-note", slots.map(slot => `${slot.tag} ${slot.source}`).join(" · ")));
        else inspector.append(el("p", "hsd-note", "Reference mode needs at least one image, video or audio source."));
    }

    async addImages(files) {
        if (!files.length) return;
        await this.perform(async () => {
            let added = 0;
            try {
                this.notice("Uploading reference media…");
                for (const file of files) {
                    await this.uploadAsset(file, file.name);
                    added++;
                }
            } finally {
                if (added) {
                    await this.readAssets();
                    this.renderInspector();
                }
            }
            this.notice(added === 1 ? "File added to the reference library" : `${added} files added to the reference library`);
        });
    }

    async readAssets() { this.assets = await request("/assets"); }

    async uploadAsset(file, name) {
        const payload = new FormData();
        payload.append("image", file, name);
        return request("/assets", { method: "POST", body: payload });
    }

    media(token, type) { return api.apiURL(`${PREFIX}/media/${this.project.id}/${token}/${type}`); }

    renderLiveSettings() {
        const box = $(this.dialog, "[data-live-options]");
        box.replaceChildren();
        this.previewControls = [];
        const settings = this.project.live_preview;
        const availability = this.options.live_preview;
        this.monitor.configure(settings?.enabled);
        if (!settings || !availability) {
            box.append(el("p", "hsd-note", "Restart ComfyUI to load live preview controls."));
            return;
        }
        const enabled = inputField(box, "Enable live preview", "checkbox", settings.enabled, value => {
            settings.enabled = value;
            if (!value) this.monitor.clear();
            this.monitor.configure(value);
            this.commit();
        });
        this.previewControls.push(enabled);
        const details = el("details", "hsd-details hsd-live-settings");
        details.append(el("summary", "", "Preview settings"));
        const grid = el("div", "hsd-grid");
        for (const [key, label] of [["resolution", "Max edge (px)"], ["jpeg_quality", "JPEG quality"], ["frames", "Frames"], ["fps", "Playback FPS"]]) {
            const [min, max] = availability.limits[key];
            const input = inputField(grid, label, "number", settings[key], value => {
                settings[key] = Math.min(max, Math.max(min, Math.round(value)));
                input.value = settings[key];
                this.commit();
            }, 1);
            input.min = min;
            input.max = max;
            this.previewControls.push(input);
        }
        details.append(grid, el("p", "hsd-note", availability.available
            ? "Uses the CPU tiny VAE. Settings apply to the next render."
            : "Live images require KJNodes and taeh3.safetensors. Sampling metrics remain available."));
        box.append(details);
    }

    renderPreview() {
        const select = $(this.dialog, "[data-preview-select]");
        const scene = this.status.scenes?.[this.active];
        const items = [];
        if (scene?.preview) items.push([`scene:${scene.preview}`, "Rendered scene"]);
        scene?.passes?.forEach((pass, index) => items.push([`preview:${pass.token}`, `Scene segment ${index + 1}`]));
        if (this.status.film) items.push([`film:${this.status.film}`, this.status.film_stale ? "Previous film export" : "Full film"]);
        const result = this.status.result_preview;
        if (result && !items.some(item => item[0] === `${result.kind}:${result.token}`)) {
            items.unshift([`${result.kind}:${result.token}`, "Latest render"]);
        }
        select.replaceChildren();
        for (const [value, label] of items) {
            const option = el("option", "", label);
            option.value = value;
            select.append(option);
        }
        select.disabled = !items.length;
        select.value = items.some(item => item[0] === this.previewToken) ? this.previewToken : items[0]?.[0] ?? "";
        this.showPreview(select.value);
    }

    showPreview(value) {
        this.previewToken = value;
        this.saveVideoButton.hidden = !value || !this.options.save_preview;
        const video = $(this.dialog, "video");
        const empty = $(this.dialog, "[data-preview-empty]");
        video.hidden = !value;
        empty.hidden = !!value;
        if (value) {
            const [type, token] = value.split(":");
            const source = this.media(token, type);
            if (video.getAttribute("src") !== source) video.src = source;
        } else if (video.hasAttribute("src")) {
            video.removeAttribute("src");
            video.load();
        }
        const report = this.status.report;
        const caption = $(this.dialog, "[data-monitor-caption]");
        caption.replaceChildren();
        if (report) caption.append(el("span", "", `${report.generated_passes} generated · ${report.cached_passes} cached · ${report.render_seconds}s`));
        if (this.status.film) {
            const link = el("a", "", this.status.film_stale ? "Download previous export" : "Download film");
            link.href = this.media(this.status.film, "film");
            link.download = (this.project.name || "film") + ".mp4";
            caption.append(link);
        }
    }

    renderProgress() {
        const state = this.status;
        const phase = state.phase;
        const running = !!this.queueId || state.queued || activePhases.has(phase);
        this.queueButton.disabled = running;
        this.resumeButton.disabled = running;
        this.redoButton.disabled = running;
        this.cancelButton.disabled = !running;
        this.saveVideoButton.disabled = this.saving || !!this.saveQueueId;
        this.previewControls.forEach(input => { input.disabled = running; });
        $(this.dialog, "progress").value = state.total ? (state.completed + (this.fractional || 0)) / state.total : 0;
        if (!this.message) {
            const scene = this.project.scenes.find(scene => scene.id === state.scene);
            const label = (state.queued && !activePhases.has(phase)) ? "Queued" : state.error || phaseLabel[phase] || (this.queueId ? "Queued" : "Ready");
            const node = $(this.dialog, "[data-status]");
            node.textContent = scene && activePhases.has(phase) ? `${label} · ${scene.title} · pass ${state.pass_index || 1}/${state.pass_count || 1}` : label;
            node.classList.toggle("hsd-error", phase === "failed");
        }
    }

    async refresh() {
        const id = this.project.id;
        const state = await request("/status/" + id);
        if (id !== this.project.id || !this.dialog.open) return;
        const changed = JSON.stringify(state) !== JSON.stringify(this.status);
        if (changed) {
            this.status = state;
            this.fractional = 0;
            this.message = null;
            if (state.phase === "complete" && this.monitor.completed !== state.prompt_id) {
                const result = state.result_preview;
                if (result) this.previewToken = `${result.kind}:${result.token}`;
                this.monitor.complete(state.prompt_id);
            }
            this.renderTimeline();
            this.renderPreview();
            this.updateFirstFramePreview();
        }
        if (this.queueId && state.prompt_id === this.queueId && !activePhases.has(state.phase)) this.queueId = null;
        if (this.queueId && state.prompt_id !== this.queueId) {
            const response = await api.fetchApi("/history/" + this.queueId);
            const history = await response.json();
            const finished = history[this.queueId];
            if (finished?.status) {
                this.queueId = null;
                const failure = finished.status.messages?.find(item => item[0] === "execution_error");
                if (failure) this.notice(failure[1].exception_message, true);
                else if (!finished.status.completed) this.notice("The queued render was interrupted.");
            }
        }
        if (this.saveQueueId) {
            const id = this.saveQueueId;
            const response = await api.fetchApi("/history/" + id);
            const saved = (await response.json())[id];
            if (saved?.status && this.saveQueueId === id) {
                this.saveQueueId = null;
                const files = Object.values(saved.outputs ?? {}).flatMap(output => output.images ?? []);
                const failure = saved.status.messages?.find(item => item[0] === "execution_error");
                if (files.length && saved.status.completed) {
                    const paths = files.map(file => [file.subfolder, file.filename].filter(Boolean).join("/"));
                    this.notice(`Saved to output/${paths.join(", output/")}`);
                } else {
                    this.notice(failure?.[1].exception_message || "Save Video did not finish.", true);
                }
            }
        }
        this.renderProgress();
    }

    async saveProject() {
        await request("/project/" + this.project.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.project) });
        this.notice("Project saved");
    }

    directorTarget(snapshot) {
        const id = String(this.node.id);
        const matches = Object.entries(snapshot.output).filter(([, entry]) => entry.class_type === NODE &&
            entry.inputs.project === this.widget.value);
        const target = snapshot.output[id]?.class_type === NODE ? id : matches.length === 1 ? matches[0][0] : null;
        if (!target) throw new Error("Include this Director node in the active workflow.");
        return target;
    }

    async savePreview() {
        if (!this.previewToken || this.saving || this.saveQueueId) return;
        const [kind, token] = this.previewToken.split(":");
        const project_id = this.project.id;
        this.saving = true;
        this.renderProgress();
        try {
            let snapshot = await app.graphToPrompt();
            let director = this.directorTarget(snapshot);
            const connected = () => Object.entries(snapshot.output).filter(([, entry]) => entry.class_type === "SaveVideo" &&
                String(entry.inputs.video?.[0]) === director && entry.inputs.video[1] === 0);
            let targets = connected();
            if (!targets.length) {
                const save = window.LiteGraph?.createNode("SaveVideo");
                if (!save) throw new Error("The built-in Save Video node is unavailable.");
                save.pos = [this.node.pos[0] + this.node.size[0] + 60, this.node.pos[1]];
                this.node.graph.add(save);
                this.node.connect(0, save, save.findInputSlot("video"));
                snapshot = await app.graphToPrompt();
                director = this.directorTarget(snapshot);
                targets = connected();
                if (!targets.length) throw new Error("Could not connect Save Video to this Director.");
            }
            const source = "hsd-approved-preview";
            // Queue the exact file the user approved, using the canvas node's export settings.
            const output = Object.fromEntries(targets.map(([id, entry]) => [id, {
                ...entry, inputs: { ...entry.inputs, video: [source, 0] },
            }]));
            output[source] = { class_type: APPROVED_VIDEO, inputs: { project_id, kind, token } };
            const result = await api.queuePrompt(0, { ...snapshot, output }, { partialExecutionTargets: targets.map(([id]) => id) });
            this.saveQueueId = result.prompt_id;
            this.notice("Save Video queued");
            await this.refresh();
        } finally {
            this.saving = false;
            this.renderProgress();
        }
    }

    async queue(mode) {
        this.queueButton.disabled = this.resumeButton.disabled = this.redoButton.disabled = true;
        try {
            await this.saveProject();
            const snapshot = await app.graphToPrompt();
            const target = this.directorTarget(snapshot);
            const action = mode ? { scene: this.active, mode } : null;
            if (mode === "regenerate") action.nonce = uuid();
            snapshot.output[target].inputs.action = action ? JSON.stringify(action) : "";
            const result = await api.queuePrompt(0, snapshot, { partialExecutionTargets: [target] });
            this.queueId = result.prompt_id;
            this.notice("Queued");
            await this.refresh();
        } finally {
            this.renderProgress();
        }
    }

    async cancel() {
        const result = await request("/cancel/" + this.project.id, { method: "POST" });
        this.queueId = null;
        this.notice(result.cancelled ? "Cancellation requested" : "No queued render for this project");
        await this.refresh();
    }

    setProject(project) {
        this.project = withDefaults(project, this.options);
        this.status = {};
        this.message = null;
        this.queueId = null;
        this.monitor.clear();
        this.monitor.select("rendered");
        this.renderLiveSettings();
        this.commit();
        this.select(project.scenes[0].id);
        return this.refresh();
    }

    async newProject() {
        const { project } = await request("/options");
        await this.setProject(project);
        this.tab = "project";
        this.renderInspector();
    }

    async openProject() {
        const files = await request("/projects");
        if (!files.length) return this.notice("No saved projects yet.");
        const chooser = el("dialog", "hsd hsd-chooser");
        chooser.append(el("h2", "", "Open saved project"));
        for (const file of files) chooser.append(button(file.name, () => this.perform(async () => {
            await this.setProject(await request("/project/" + file.id));
            chooser.close();
        })));
        chooser.append(button("Close", () => chooser.close()));
        chooser.addEventListener("close", () => chooser.remove());
        document.body.append(chooser);
        chooser.showModal();
    }

    chooseImport() {
        const input = el("input", "hsd-file");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = () => this.perform(async () => {
            if (!input.files.length) return;
            const stored = JSON.parse(await input.files[0].text());
            const project = stored.project ?? stored;
            if (project.version !== 1 || !/^[a-f0-9]{32}$/.test(project.id) || !project.scenes?.length ||
                project.scenes.some(scene => !scene.passes?.length)) throw new Error("Select a valid Director project JSON.");
            const existing = new Set(this.assets.map(asset => asset.id));
            const mapped = new Map();
            for (const [id, asset] of Object.entries(stored.assets || {})) {
                if (existing.has(id)) continue;
                if (!/^data:(?:(?:image|video|audio)\/[\w.+-]+|application\/octet-stream);base64,/.test(asset.data)) {
                    throw new Error("The project contains an invalid reference.");
                }
                const blob = await (await fetch(asset.data)).blob();
                mapped.set(id, (await this.uploadAsset(blob, asset.name)).id);
            }
            remapAssets(project, mapped);
            await request("/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) });
            await this.readAssets();
            await this.setProject(project);
        });
        input.click();
    }

    async exportProject() {
        const ids = assetIds(this.project);
        const assets = {};
        for (const id of ids) {
            const response = await api.fetchApi(PREFIX + "/assets/" + id);
            if (!response.ok) throw new Error("A referenced image is missing from the library.");
            const file = await response.blob();
            const data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            assets[id] = { name: this.assets.find(asset => asset.id === id)?.name ?? id, data };
        }
        const url = URL.createObjectURL(new Blob([JSON.stringify({ project: this.project, assets }, null, 2)], { type: "application/json" }));
        const link = el("a");
        link.href = url;
        link.download = (this.project.name || "H3 SPEED project") + ".json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

app.registerExtension({
    name: "h3.speed.director",
    async nodeCreated(node) {
        if (node.comfyClass !== NODE) return;
        const widget = node.widgets?.find(item => item.name === "project");
        if (!widget) return;
        for (const item of node.widgets.filter(item => ["project", "action"].includes(item.name))) {
            item.hidden = true;
        }
        node.addWidget("button", "Open Director", null, async () => {
            if (node.h3Editor || node.h3Opening) return;
            node.h3Opening = true;
            try {
                const options = await request("/options");
                if (options.fantastic) {
                    try {
                        options.compiler = await import(api.apiURL(PREFIX + "/fantastic.js"));
                        options.compiler.setNamePrefix(options.compiler.loadPrefs().namePrefix);
                    } catch (error) {
                        options.fantasticError = `Fantastic PromptBuilder could not load. ${error.message}`;
                    }
                }
                const saved = widget.value ? JSON.parse(widget.value) : options.project;
                const project = withDefaults(saved, options);
                const styleId = "h3-speed-director-css";
                if (!document.getElementById(styleId)) {
                    const style = el("link");
                    style.id = styleId;
                    style.rel = "stylesheet";
                    style.href = new URL("./director.css", import.meta.url);
                    document.head.append(style);
                }
                node.h3Editor = new Editor(node, widget, options, project);
                node.h3Editor.readAssets().then(() => node.h3Editor?.renderInspector()).catch(error => node.h3Editor?.notice(error.message, true));
            } catch (error) { window.alert(`H3 SPEED Director\n${error.message}`); }
            finally { node.h3Opening = false; }
        }, { serialize: false });
    },
});

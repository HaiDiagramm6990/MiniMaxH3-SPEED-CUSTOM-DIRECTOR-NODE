const mediaFields = ["first_frame", "last_frame", "references", "videos", "audios", "ref_image_size"];

export const generationOf = (scene, pass) => pass.generation ?? scene.generation ?? "legacy";
export const settingsFor = (project, scene, pass) => ({ ...project.settings, ...scene.overrides, ...pass.overrides });
export function mediaFor(scene, pass) {
    const defaults = Object.fromEntries(mediaFields.map(key => [key, scene[key]]));
    if (pass.mode === "extend") delete defaults.first_frame;
    return { ...defaults, ...pass.media };
}
export const carriesReference = (scene, pass) => pass.mode === "generate" &&
    (scene.transition === "continuous" || (scene.transition === "reference" && scene.previous_reference));

export function firstFrameSource(scene, pass, linked) {
    const mode = generationOf(scene, pass);
    if (mode === "legacy") {
        if (pass.mode !== "generate") return null;
        if (scene.transition === "continuous") return { kind: "scene-tail" };
        if (linked) return { kind: "graph" };
        return scene.first_frame ? { kind: "asset", asset: scene.first_frame } : null;
    }
    if (!["I2VA", "FL2VA"].includes(mode)) return null;
    const asset = mediaFor(scene, pass).first_frame;
    if (asset) return { kind: "asset", asset, override: Boolean(pass.media?.first_frame) };
    if (pass.mode === "replace") return { kind: "pass-head" };
    if (pass.mode === "extend") return { kind: "pass-tail" };
    if (scene.transition === "continuous") return { kind: "scene-tail" };
    if (linked) return { kind: "graph" };
    return { kind: "missing" };
}

export function retainsOverlap(scene, pass, preceding) {
    const mode = generationOf(scene, pass);
    if (mode !== "legacy") {
        if (!["I2VA", "FL2VA"].includes(mode) || mediaFor(scene, pass).first_frame) return false;
    }
    return pass.mode === "extend" || (pass.mode === "generate" && scene.transition === "continuous")
        || (pass.mode === "replace" && Boolean(preceding));
}

export function materializePrompt(compiler, project, scene, pass) {
    const mode = generationOf(scene, pass);
    if (mode === "legacy") return null;
    const old = pass.builder;
    const state = old?.version ? old : compiler.normaliseState(old);
    if (!old?.version && pass.prompt) {
        state.imd = pass.prompt;
        state.ref.detail = pass.prompt;
    }
    state.mode = mode;
    state.duration = compiler.snapLength(settingsFor(project, scene, pass).frames / 24) / 24;
    pass.builder = state;
    const globals = [["Character", project.character], ["Environment", project.environment], ["Visual style", project.style]]
        .filter(([, text]) => text?.trim()).map(([label, text]) => `${label} — ${text.trim()}`).join(" ");
    const compiled = { ...state, imd: [globals, state.imd].filter(Boolean).join(" "),
        ref: { ...state.ref, styleLine: [globals, state.ref.styleLine].filter(Boolean).join(" ") } };
    pass.compiled_prompt = compiler.generate(compiled);
    return compiled;
}

export function referenceSlots(compiler, scene, pass, assets, linkedFirst) {
    const mode = generationOf(scene, pass);
    const media = mediaFor(scene, pass);
    const slots = [];
    const add = (kind, source) => {
        const idx = slots.filter(slot => slot.kind === kind).length + 1;
        slots.push({ kind, idx, tag: `<${kind} ${idx}>`, source, slotName: source });
    };
    const name = id => assets.find(asset => asset.id === id)?.name ?? id;
    if (mode !== "REF") {
        for (const role of Object.values(compiler.MODE_CAPACITY[mode].roles)) {
            const isFirst = role === "first frame";
            const asset = isFirst ? media.first_frame : media.last_frame;
            if (asset || (isFirst ? linkedFirst || pass.mode !== "generate" || scene.transition === "continuous" : pass.mode === "replace")) {
                add("Picture", asset ? name(asset) : role);
            }
        }
        return slots;
    }
    if (carriesReference(scene, pass)) add("Picture", "Previous scene tail");
    for (const asset of media.references ?? []) add("Picture", name(asset));
    const hasSound = entry => assets.some(asset => asset.id === entry.asset && asset.has_audio);
    for (const entry of media.videos ?? []) {
        if (entry.audio_mode === "paired" && hasSound(entry)) add("Audio", name(entry.asset));
        add("Video", name(entry.asset));
    }
    for (const entry of media.videos ?? []) {
        if (entry.audio_mode === "standalone" && hasSound(entry)) add("Audio", name(entry.asset));
    }
    for (const asset of media.audios ?? []) add("Audio", name(asset));
    return slots;
}

export function* mediaOwners(project) {
    for (const scene of project.scenes) {
        yield scene;
        for (const pass of scene.passes) if (pass.media) yield pass.media;
    }
}

export function assetIds(project) {
    const ids = new Set();
    for (const media of mediaOwners(project)) {
        for (const id of [media.first_frame, media.last_frame, ...(media.references ?? []), ...(media.audios ?? []),
            ...(media.videos ?? []).map(video => video.asset)]) if (id) ids.add(id);
    }
    return ids;
}

export function remapAssets(project, mapped) {
    for (const media of mediaOwners(project)) {
        for (const field of ["first_frame", "last_frame"]) {
            if (mapped.has(media[field])) media[field] = mapped.get(media[field]);
        }
        for (const field of ["references", "audios"]) {
            if (media[field]) media[field] = media[field].map(id => mapped.get(id) ?? id);
        }
        for (const video of media.videos ?? []) video.asset = mapped.get(video.asset) ?? video.asset;
    }
}

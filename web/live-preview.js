const svg = name => document.createElementNS("http://www.w3.org/2000/svg", name);

function chart(container, label, field) {
    const header = document.createElement("strong");
    header.textContent = label;
    const scale = document.createElement("span");
    const plot = svg("svg");
    plot.setAttribute("viewBox", "0 0 220 52");
    plot.setAttribute("role", "img");
    plot.setAttribute("aria-label", label);
    const grid = svg("path");
    grid.setAttribute("d", "M2 8H218 M2 27H218 M2 46H218");
    grid.classList.add("hsd-live-gridline");
    const line = svg("polyline");
    line.classList.add("hsd-live-line");
    const marker = svg("circle");
    marker.setAttribute("r", "2.5");
    marker.classList.add("hsd-live-marker");
    plot.append(grid, line, marker);
    container.append(header, scale, plot);
    return (steps, total) => {
        const values = Array.from(steps.values()).filter(sample => Number.isFinite(sample[field]));
        const limit = Math.max(1, ...values.map(sample => sample[field]));
        scale.textContent = values.length ? `0–${field === "sigma" ? limit.toFixed(2) : Math.ceil(limit).toLocaleString()}` : "—";
        const points = values.map(sample => [
            2 + Math.min(1, (sample.step - 1) / Math.max(1, total - 1)) * 216,
            46 - Math.min(1, sample[field] / limit) * 38,
        ]);
        line.setAttribute("points", points.map(point => point.join(",")).join(" "));
        const last = points.at(-1);
        marker.style.display = last ? "" : "none";
        if (last) {
            marker.setAttribute("cx", last[0]);
            marker.setAttribute("cy", last[1]);
        }
    };
}

export class PreviewMonitor {
    constructor(root) {
        this.renderedTab = root.querySelector("[data-rendered-tab]");
        this.liveTab = root.querySelector("[data-live-tab]");
        this.rendered = root.querySelector("[data-rendered-panel]");
        this.live = root.querySelector("[data-live-panel]");
        this.source = root.querySelector("[data-preview-select]");
        this.canvas = root.querySelector("[data-live-canvas]");
        this.message = root.querySelector("[data-live-empty]");
        this.metrics = root.querySelector("[data-live-metrics]");
        this.graphs = [chart(root.querySelector("[data-sigma-chart]"), "Sigma", "sigma"),
            chart(root.querySelector("[data-time-chart]"), "Step time (ms)", "step_ms")];
        this.renderedTab.onclick = () => this.select("rendered");
        this.liveTab.onclick = () => this.select("live");
        this.clear();
        this.select("rendered");
    }

    select(view) {
        this.view = view;
        const live = view === "live";
        this.renderedTab.setAttribute("aria-pressed", String(!live));
        this.liveTab.setAttribute("aria-pressed", String(live));
        this.rendered.hidden = this.source.hidden = live;
        this.live.hidden = !live;
        if (live) {
            this.rendered.querySelector("video").pause();
            this.play();
        } else {
            this.stopPlayback();
        }
    }

    clear() {
        this.stopPlayback();
        this.prompt = null;
        this.completed = null;
        this.pass = null;
        this.steps = new Map();
        this.total = 0;
        this.sheet = null;
        this.frameVersion = (this.frameVersion ?? 0) + 1;
        this.canvas.hidden = true;
        this.metrics.textContent = "";
        this.graphs.forEach(draw => draw(this.steps, 0));
        this.configure(this.enabled);
    }

    configure(enabled) {
        this.enabled = enabled;
        if (!this.prompt) {
            this.message.textContent = enabled ? "Waiting for sampling" : "Live preview is off";
            this.message.hidden = false;
        }
    }

    complete(prompt) {
        if (!prompt || this.completed === prompt) return;
        this.completed = prompt;
        this.select("rendered");
    }

    receive(event) {
        if (event.prompt_id === this.completed) return;
        if (event.kind === "step" && this.prompt === null) this.receive({ ...event, kind: "start" });
        const pass = `${event.scene}:${event.pass_index}`;
        if (event.kind === "start") {
            const newPrompt = this.prompt !== event.prompt_id;
            this.prompt = event.prompt_id;
            this.pass = pass;
            this.total = event.total;
            this.steps.clear();
            this.stopPlayback();
            this.sheet = null;
            this.frameVersion++;
            this.canvas.hidden = true;
            this.message.hidden = false;
            this.message.textContent = event.error || "Waiting for the first frame";
            this.metrics.textContent = `${event.scene_title} · Pass ${event.pass_index}/${event.pass_count}`;
            this.graphs.forEach(draw => draw(this.steps, this.total));
            if (newPrompt) this.select("live");
            return;
        }
        if (this.prompt !== event.prompt_id || this.pass !== pass) return;
        if (event.kind === "step") {
            this.steps.set(event.step, event);
            const sigma = Number.isFinite(event.sigma) ? event.sigma.toFixed(4) : "—";
            this.metrics.textContent = `${event.scene_title} · Pass ${event.pass_index}/${event.pass_count} · Step ${event.step}/${event.total} · Stage ${event.stage} · σ ${sigma} · ${event.step_ms.toFixed(1)} ms`;
            this.graphs.forEach(draw => draw(this.steps, event.total));
        } else if (event.kind === "frames") {
            const version = ++this.frameVersion;
            const image = new Image();
            image.onload = () => {
                if (this.frameVersion !== version || this.completed === event.prompt_id) return;
                this.sheet = { ...event, image };
                delete this.sheet.jpeg;
                this.canvas.width = event.width;
                this.canvas.height = event.height;
                this.canvas.hidden = false;
                this.message.hidden = true;
                this.play();
            };
            image.src = "data:image/jpeg;base64," + event.jpeg;
        } else if (event.kind === "error") {
            this.message.hidden = false;
            this.message.textContent = event.error;
        }
    }

    play() {
        this.stopPlayback();
        if (!this.sheet || this.view !== "live") return;
        const { image, width, height, frames, columns, fps } = this.sheet;
        const context = this.canvas.getContext("2d", { alpha: false });
        let frame = 0;
        const draw = () => {
            context.drawImage(image, (frame % columns) * width, Math.floor(frame / columns) * height,
                width, height, 0, 0, width, height);
            frame = (frame + 1) % frames;
        };
        draw();
        if (frames > 1) this.timer = setInterval(draw, 1000 / fps);
    }

    stopPlayback() {
        clearInterval(this.timer);
        this.timer = null;
    }
}

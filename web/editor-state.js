export class ProjectHistory {
    reset() {
        this.current = null;
        this.undo = [];
        this.redo = [];
        this.group = null;
    }

    constructor() { this.reset(); }

    record(snapshot, group, now = performance.now()) {
        if (snapshot === this.current) return;
        if (this.current !== null && (!group || this.group !== group || now - this.changedAt > 800)) {
            this.undo.push(this.current);
            if (this.undo.length > 50) this.undo.shift();
        }
        this.current = snapshot;
        this.group = group;
        this.changedAt = now;
        this.redo.length = 0;
    }

    move(direction) {
        const from = this[direction];
        if (!from.length) return null;
        const to = direction === "undo" ? this.redo : this.undo;
        to.push(this.current);
        this.current = from.pop();
        this.group = null;
        return this.current;
    }
}

export function estimateRenderSeconds(state, progress, now = Date.now() / 1000) {
    const timing = state.eta;
    if (!timing || timing.remaining_work <= 0) return null;
    const work = timing.pass_work;
    const measured = timing.seconds_per_work;
    if (measured > 0) {
        const elapsed = work ? Math.max(0, now - timing.pass_started_at) : 0;
        return (timing.remaining_work - work) * measured + (work ? Math.max(1, work * measured - elapsed) : 0);
    }
    if (state.phase !== "sampling" || !work || !progress || progress.step < 2) return null;
    const duration = (progress.at - state.phase_started_at) / progress.fraction;
    if (!(duration > 0)) return null;
    const other = (timing.remaining_work - work) / work * duration;
    return other + Math.max(1, duration - Math.max(0, now - state.phase_started_at));
}

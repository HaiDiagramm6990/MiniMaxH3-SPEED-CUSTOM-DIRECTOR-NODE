const mediaTag = /<(Picture|Video|Audio) [1-9]\d*>/g;
const supportedTag = /^<(Picture|Video|Audio|Subject) [1-9]\d*>$/;
const possibleTag = /<\s*(?:pic(?:ture)?|vid(?:eo)?|aud(?:io)?|subj(?:ect)?)(?=[\s\d_>:-])[^<>\n]*>/gi;
const missingTag = /\[Missing reference: [^\]\n]+\]/g;
const shotMarker = /\[Shot (\d+)\]/gi;
const timestamp = /\d{2}:\d{2}\.\d{3}/;
const speaker = /\(S[1-9]\d*(?:,S[1-9]\d*)*\)/g;
const fps = 24;

export function subjectSlots(pass, slots) {
    if (pass.builder?.off?.subject_definitions) return [];
    const subjects = new Map();
    for (const entry of pass.builder?.ref?.subjectDefs ?? []) {
        const tag = entry.text?.trim().match(/^<Subject [1-9]\d*>/)?.[0];
        if (!tag || entry.off || subjects.has(tag)) continue;
        const cited = [...entry.text.matchAll(mediaTag)].map(match => match[0]);
        const media = cited.map(token => slots.find(slot => slot.tag === token && !slot.missing));
        const visual = media.find(slot => slot?.kind === "Picture") ?? media.find(slot => slot?.kind === "Video") ?? media.find(Boolean);
        subjects.set(tag, { ...visual, kind: "Subject", tag, source: entry.name?.trim() || tag.slice(1, -1) });
    }
    return [...subjects.values()];
}

export function promptFields(pass, mode) {
    const fields = [[pass, "negative"]];
    if (mode === "legacy") return [[pass, "prompt"], ...fields];
    if (!pass.builder) return fields;
    if (mode !== "REF") return [...fields, ...["imd", "soundscape", "music"].map(key => [pass.builder, key])];
    const ref = pass.builder.ref;
    return [...fields, ...["summaryText", "styleLine", "detail", "soundscape", "music"].map(key => [ref, key]),
        ...ref.subjectDefs.flatMap(row => [[row, "text"], [row, "voice"]]),
        ...ref.retention.flatMap(row => ["label", "context", "note"].map(key => [row, key]))];
}

export function rebaseReferences(value, before, after) {
    const old = new Map(before.map(slot => [slot.tag, slot]));
    const next = new Map(after.map(slot => [slot.identity, slot.tag]));
    return value.replace(mediaTag, token => {
        const slot = old.get(token);
        if (!slot) return token;
        return next.get(slot.identity) ?? `[Missing reference: ${slot.source.replace(/[\]\r\n]/g, " ")}]`;
    });
}

export function referenceFragment(value, start, end) {
    if (start !== end) return null;
    const match = value.slice(0, start).match(/<([\p{L}\p{N}_. -]*)$/u);
    if (!match) return null;
    // If the caret is inside a completed token, replace that token as a unit.
    const closing = value.slice(start).match(/^[\w ]*>/)?.[0];
    return { start: match.index, end: end + (closing?.length ?? 0), query: match[1].toLowerCase().trim() };
}

export function insertPrompt(value, start, end, text, paragraph = false) {
    const before = value.slice(0, start), after = value.slice(end);
    const lead = paragraph ? (before && !before.endsWith("\n\n") ? before.endsWith("\n") ? "\n" : "\n\n" : "") :
        (/[\p{L}\p{N}>.!?]$/u.test(before) ? " " : "");
    const trail = paragraph ? (after && !after.startsWith("\n\n") ? after.startsWith("\n") ? "\n" : "\n\n" : "") :
        (/^[\p{L}\p{N}<]/u.test(after) ? " " : "");
    return { value: before + lead + text + trail + after, cursor: before.length + lead.length + text.length + trail.length };
}

export function speakerIds(text) {
    return [...text.matchAll(speaker)].flatMap(match => match[0].slice(1, -1).split(","));
}

const sentenceEnd = /[.!?。！？؟]$/u;
const decorative = /[~〜•★☆*…]|[!?.,。！？]{2,}|\p{Extended_Pictographic}/u;

export function dialogueWarnings(text) {
    return decorative.test(text) ? ["Check decorative punctuation, repeated symbols, emoji, or ellipses. Spoken text is preserved."] : [];
}

export function buildDialogue(form) {
    const warnings = dialogueWarnings(form.words);
    const words = form.words.trim();
    if (!form.speakers.length || !form.language || !words) return { text: "", warnings };
    if (/<[^>]*>/u.test(words) || speakerIds(words).length) return { text: "", warnings: [...warnings, "Keep speaker IDs and markup outside spoken words. Use the cut control for transition markers."] };
    const duet = form.speakers.length > 1;
    const names = form.names || (duet ? "The speakers" : "The speaker");
    const who = `${form.voiceover && duet ? `The shared voice of ${form.names || "the speakers"}` : names} (${form.speakers.join(",")})`;
    const verb = form.voiceover ? "says in an off-screen voiceover" : form.singing ? duet ? "sing together" : "sings" : duet ? "say together" : "says";
    const action = form.action.trim();
    const delivery = [form.voiceover && form.singing ? "with a sung delivery" : "", form.delivery.trim()].filter(Boolean).join(" ");
    const anchor = action ? `${action.replace(/[.!?]$/, "")}. ` : "";
    const incoming = ["in", "both"].includes(form.cut), outgoing = ["out", "both"].includes(form.cut);
    const transcript = `${words}${sentenceEnd.test(words) ? "" : form.punctuation ?? "."}`;
    const byVoice = form.voiceover ? ` while ${form.speakers.length > 1 ? "their lips remain" : "the character's lips remain"} completely closed.` : "";
    const continuity = incoming && outgoing ? " The voice carries over from the previous shot and continues into the next shot." :
        incoming ? " The voice carries over from the previous shot." : outgoing ? " The voice continues seamlessly across the cut." : "";
    const audio = form.audio ? form.behavior === "reference" ? ` ${form.audio} guides the delivery.` :
        ` The delivery follows ${form.audio}.` : "";
    const begin = incoming ? "<scenetrans> " : "";
    const end = outgoing ? " <scenetrans>" : "";
    return { text: `${anchor}${who} ${verb}${delivery ? ` ${delivery}` : ""}: ${begin}<d>[${form.language}] ${transcript}</d>${byVoice}${end}${continuity}${audio}`, warnings };
}

export function cutSeconds(value) {
    const raw = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    const match = raw.match(/^(\d{2}):([0-5]\d)\.(\d{3})$/);
    return match ? +match[1] * 60 + +match[2] + +match[3] / 1000 : NaN;
}

export function shotList(value) {
    return [...value.matchAll(shotMarker)].flatMap(match => {
        const left = value.slice(value.lastIndexOf("\n", match.index - 1) + 1, match.index);
        const right = value.slice(match.index + match[0].length);
        const at = right.match(/^[ \t]+at\b[ \t]+([^,\n]*)/i);
        if (left.trim() && !at) return [];
        const stamp = +match[1] === 1 && at && !/^\d/.test(at[1].trim()) ? undefined : at?.[1].trim();
        return [{ position: match.index, token: match[0], number: +match[1], stamp,
            frame: stamp === undefined ? 0 : /^\d{2}:[0-5]\d\.\d{3}$/.test(stamp) ? Math.round(cutSeconds(stamp) * fps) : NaN }];
    });
}

export function shotWarnings(shots, frames) {
    const notes = [];
    let previous = -1;
    const seen = new Set();
    shots.forEach(({ number, frame, stamp }, i) => {
        if (seen.has(number)) notes.push(`[Shot ${number}] is duplicated.`);
        else if (number !== i + 1) notes.push(`[Shot ${number}] is out of sequence.`);
        seen.add(number);
        if (i === 0 && stamp !== undefined) notes.push("The opening shot begins at 0.00 seconds without a written cut timestamp.");
        if (i > 0 && (stamp === undefined || !Number.isFinite(frame))) notes.push(`[Shot ${number}] needs one At MM:SS.mmm, cut time.`);
        if (Number.isFinite(frame) && frame <= previous) notes.push(`[Shot ${number}] must start after the preceding shot on the 24 fps grid.`);
        if (frame >= frames) notes.push(`[Shot ${number}] is outside this ${frames}-frame pass at 24 fps.`);
        if (Number.isFinite(frame)) previous = frame;
    });
    return notes;
}

export function formatCut(frame) {
    const ms = Math.round(frame * 1000 / fps);
    return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function renumberShots(value, cursor = value.length) {
    let offset = 0;
    let nextCursor = cursor;
    for (const [index, shot] of shotList(value).entries()) {
        const token = `[Shot ${index + 1}]`;
        const at = shot.position + offset;
        value = value.slice(0, at) + token + value.slice(at + shot.token.length);
        const delta = token.length - shot.token.length;
        if (at < nextCursor) nextCursor += delta;
        offset += delta;
    }
    return { value, cursor: nextCursor };
}

export function buildShot(form, value, cursor, frames) {
    const number = form.renumber ? shotList(value).filter(shot => shot.position < cursor).length + 1 : Number(form.number);
    const seconds = cutSeconds(form.time);
    const frame = Math.round(seconds * fps);
    const warnings = [];
    if (!Number.isSafeInteger(number) || number < 1) warnings.push("Enter a positive shot number.");
    if (number === 1 && seconds !== 0) warnings.push("Shot 1 starts at 0.00 seconds.");
    if (number > 1 && (!Number.isFinite(seconds) || frame <= 0 || seconds >= frames / fps || frame >= frames)) {
        warnings.push(`Enter a positive cut time inside the ${frames}-frame pass at 24 fps.`);
    }
    const subject = form.description.trim();
    const framing = form.framing.trim();
    if (!subject && !framing) return { text: "", warnings: [...warnings, "Describe what the shot shows."] };
    const motion = [form.movement, form.action].map(text => {
        const part = text.trim();
        return part ? (sentenceEnd.test(part) ? part : `${part}.`) : "";
    }).filter(Boolean);
    const open = [framing, subject].filter(Boolean).join(" showing ");
    const transition = { cut: "the camera cuts to", dissolve: "the shot dissolves to", fade: "the shot fades into", wipe: "the shot wipes to",
        custom: form.custom.trim() }[form.transition];
    if (number > 1 && !transition) warnings.push("Enter a custom camera transition.");
    const description = open.charAt(0).toUpperCase() + open.slice(1);
    const head = number === 1 ? description : `At ${Number.isFinite(seconds) ? formatCut(frame) : "…"}, ${transition} ${open}`;
    const end = form.audio && number > 1 ? " The audio continues seamlessly across the cut." : "";
    const text = `[Shot ${number}] ${sentenceEnd.test(head) ? head : `${head}.`}${motion.length ? ` ${motion.join(" ")}` : ""}${end}`;
    const inserted = insertPrompt(value, cursor, cursor, text, true);
    const result = form.renumber ? renumberShots(inserted.value, inserted.cursor) : inserted;
    const structure = warnings.length ? [] : shotWarnings(shotList(result.value), frames);
    return { text, result, warnings: [...warnings, ...structure] };
}

export function promptMarks(value, slots, frames, languages, narrative) {
    const lookup = new Map(slots.map(slot => [slot.tag, slot]));
    const marks = [], warnings = new Set();
    for (const match of value.matchAll(new RegExp(`${possibleTag.source}|${missingTag.source}`, "gi"))) {
        const token = match[0];
        const slot = lookup.get(token);
        const valid = supportedTag.test(token);
        if (!slot || slot.missing) warnings.add(valid ? `${token} is unavailable for this pass.` :
            token.startsWith("[") ? `${token} was removed or replaced.` : `${token} has invalid syntax. Use a tag such as <Picture 1>.`);
        marks.push({ at: match.index, text: token, kind: slot && !slot.missing ? "reference" : "warning", slot });
    }
    const pattern = new RegExp(`${shotMarker.source}|${timestamp.source}|${speaker.source}|</?d>|<scenetrans>|<cutoff>|\\[unclear\\]|\\[(?:${languages.join("|") || "(?!)"})\\]`, "g");
    for (const match of value.matchAll(pattern)) marks.push({ at: match.index, text: match[0], kind: "syntax" });
    if (narrative) shotWarnings(shotList(value), frames).forEach(note => warnings.add(note));
    let dialogueOpen = false;
    for (const match of value.matchAll(/<\/?d>/g)) {
        const opening = match[0] === "<d>";
        if (opening === dialogueOpen) warnings.add("Check the opening and closing dialogue tags.");
        dialogueOpen = opening;
    }
    if (dialogueOpen) warnings.add("Close the dialogue with </d>.");
    if (narrative && (value.match(/<scenetrans>/g)?.length ?? 0) % 2) {
        warnings.add("Check the matching <scenetrans> marker on the other side of the cut.");
    }
    for (const match of value.matchAll(/<d>(.*?)<\/d>/gs)) {
        const language = match[1].match(/^\s*\[([^\]]+)\]/)?.[1];
        if (languages.length && !languages.includes(language)) warnings.add("Each dialogue block needs a supported [Language] tag.");
        const words = match[1].replace(/^\s*\[[^\]]+\]/, "").replaceAll("<scenetrans>", "").replaceAll("<cutoff>", "").trim();
        if (speakerIds(words).length) warnings.add("Place speaker IDs outside the dialogue tags.");
        if (words && !sentenceEnd.test(words)) warnings.add("End complete spoken lines with sentence punctuation.");
        dialogueWarnings(words).forEach(note => warnings.add(note));
    }
    return { marks: marks.sort((a, b) => a.at - b.at), warnings: [...warnings] };
}

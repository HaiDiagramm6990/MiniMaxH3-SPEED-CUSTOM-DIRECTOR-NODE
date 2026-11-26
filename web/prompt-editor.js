import { buildDialogue, buildShot, formatCut, insertPrompt, promptMarks, referenceFragment, renumberShots, shotList } from "./prompt-syntax.js";

let sequence = 0;

function node(tag, cls, text) {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text) element.textContent = text;
    return element;
}

function button(text, click, cls) {
    const element = node("button", cls, text);
    element.type = "button";
    element.onclick = click;
    return element;
}

function control(mount, label, value = "", options = "text", change) {
    const wrap = node("label", "hsd-field");
    const input = node(Array.isArray(options) ? "select" : options === "textarea" ? "textarea" : "input");
    if (Array.isArray(options)) for (const item of options) {
        const [key, text] = Array.isArray(item) ? item : [item, item];
        const option = node("option", "", text);
        option.value = key;
        input.append(option);
    }
    else if (options !== "textarea") input.type = options;
    if (options === "checkbox") input.checked = value;
    else input.value = value;
    if (change) input.addEventListener(Array.isArray(options) || options === "checkbox" ? "change" : "input", change);
    wrap.append(node("span", "", label), input);
    mount.append(wrap);
    return input;
}

function previewMedia(slot, thumbnail = false) {
    if (!slot.url) return null;
    const kind = slot.kind === "Audio" && !thumbnail ? "audio" : slot.asset?.kind ?? "image";
    if (thumbnail && kind === "audio") return null;
    const media = node(kind === "image" ? "img" : kind, thumbnail ? "hsd-token-thumb" : "hsd-token-media");
    media.src = slot.url;
    if (kind === "image") {
        media.alt = thumbnail ? "" : slot.source;
        media.loading = thumbnail ? "lazy" : "eager";
    } else {
        media.preload = "metadata";
        media.controls = !thumbnail;
        if (kind === "video") {
            media.muted = thumbnail;
            media.playsInline = true;
            if (thumbnail) media.addEventListener("loadedmetadata", () => { media.currentTime = Math.min(media.duration / 2, 0.04); }, { once: true });
        }
    }
    return media;
}

function popupPosition(popup, anchor, preferredWidth) {
    const width = Math.min(preferredWidth, innerWidth - 24);
    popup.style.width = `${width}px`;
    popup.hidden = false;
    const height = popup.offsetHeight;
    popup.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`;
    popup.style.top = `${anchor.bottom + height + 10 <= innerHeight ? anchor.bottom + 5 : Math.max(8, anchor.top - height - 5)}px`;
}

export function mountPrompt(mount, label, context, { narrative = false, compact = false } = {}) {
    const root = node("section", `hsd-prompt-entry${compact ? " hsd-prompt-compact" : ""}`);
    const id = `hsd-prompt-${++sequence}`;
    const tools = node("div", "hsd-actions hsd-prompt-tools");
    const title = node("label", "hsd-prompt-label", label);
    title.htmlFor = id;
    const body = node("div", "hsd-prompt-text");
    const mirror = node("div", "hsd-prompt-mirror");
    const painted = node("div");
    mirror.setAttribute("aria-hidden", "true");
    mirror.append(painted);
    const area = node("textarea");
    area.id = id;
    area.value = context.read();
    if (compact) area.rows = 1;
    area.setAttribute("aria-autocomplete", "list");
    const menu = node("div", "hsd-token-menu");
    menu.id = `${id}-references`;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Reference suggestions");
    area.setAttribute("aria-controls", menu.id);
    const hover = node("div", "hsd-token-hover");
    const issues = node("details", "hsd-inline-issues");
    const summary = node("summary");
    const list = node("ul");
    issues.id = `${id}-guidance`;
    issues.append(summary, list);
    area.setAttribute("aria-describedby", issues.id);
    const builder = node("div", "hsd-tool-panel");
    menu.hidden = hover.hidden = builder.hidden = issues.hidden = true;
    body.append(mirror, area);
    root.append(title, tools, builder, body, issues, menu, hover);
    tools.hidden = !narrative;
    mount.append(root);

    let cursor = area.value.length;
    let suggestions = [], selected = 0, fragment, dismissed, hoverTimer, hovered, composing = false;
    let paintValue, warningsShown;
    const align = () => {
        painted.style.width = `${area.clientWidth}px`;
        painted.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
    };
    const repaint = () => {
        const value = area.value;
        const { marks, warnings } = promptMarks(value, context.slots(), context.frames(), context.languages, narrative);
        if (paintValue !== value || marks.length || painted.children.length) {
            const content = document.createDocumentFragment();
            let offset = 0;
            for (const mark of marks) {
                if (mark.at < offset) continue;
                content.append(value.slice(offset, mark.at));
                const span = node("span", `hsd-mark-${mark.kind}`, mark.text);
                if (mark.slot && !mark.slot.missing) span.reference = mark.slot;
                content.append(span);
                offset = mark.at + mark.text.length;
            }
            content.append(value.slice(offset) + "\u200b");
            painted.replaceChildren(content);
            paintValue = value;
        }
        align();
        const warningState = warnings.join("\n");
        if (warningState !== warningsShown) {
            issues.hidden = !warnings.length;
            summary.textContent = `${warnings.length} prompt ${warnings.length === 1 ? "warning" : "warnings"}`;
            list.replaceChildren(...warnings.map(warning => node("li", "", warning)));
            warningsShown = warningState;
        }
    };
    const closeMenu = () => {
        menu.hidden = true;
        menu.replaceChildren();
        area.removeAttribute("aria-activedescendant");
    };
    const closeHover = () => {
        clearTimeout(hoverTimer);
        hover.hidden = true;
        hover.replaceChildren();
        hovered = null;
    };
    const setCursor = () => { cursor = area.selectionStart; };
    const apply = (value, at, extra) => {
        context.write(value, extra);
        area.value = context.read();
        area.focus({ preventScroll: true });
        area.setSelectionRange(at, at);
        setCursor();
        closeMenu();
        repaint();
    };
    const choose = item => {
        if (!item || !fragment) return;
        const current = area.value;
        if (item.assign) {
            const { value, at } = context.assign(item, current, fragment);
            apply(value, at);
        } else {
            apply(current.slice(0, fragment.start) + item.tag + current.slice(fragment.end), fragment.start + item.tag.length);
        }
    };
    const markActive = (scroll = false) => {
        Array.from(menu.querySelectorAll('[role="option"]')).forEach((option, i) => {
            option.setAttribute("aria-selected", String(i === selected));
            if (i === selected) {
                area.setAttribute("aria-activedescendant", option.id);
                if (scroll) {
                    const rect = option.getBoundingClientRect(), parent = menu.getBoundingClientRect();
                    if (rect.top < parent.top) menu.scrollTop += rect.top - parent.top;
                    else if (rect.bottom > parent.bottom) menu.scrollTop += rect.bottom - parent.bottom;
                }
            }
        });
    };
    const caretBox = offset => {
        const walker = document.createTreeWalker(painted, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        while (current && offset > current.length) {
            offset -= current.length;
            current = walker.nextNode();
        }
        if (!current) return area.getBoundingClientRect();
        const range = document.createRange();
        range.setStart(current, offset);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        return rect.height ? rect : area.getBoundingClientRect();
    };
    const suggest = () => {
        setCursor();
        fragment = referenceFragment(area.value, cursor, area.selectionEnd);
        const signature = `${area.value}\n${cursor}`;
        if (!fragment || signature === dismissed || composing || document.activeElement !== area) return closeMenu();
        const anchor = caretBox(cursor);
        const visible = area.getBoundingClientRect();
        if (anchor.bottom < visible.top || anchor.top > visible.bottom) return closeMenu();
        closeHover();
        const terms = fragment.query.split(/\s+/).filter(Boolean);
        const abbreviated = fragment.query.match(/^([a-z]+)\s*(\d+)$/);
        suggestions = [...context.slots().filter(slot => !slot.missing), ...context.suggestions()].filter(item => {
            const search = `${item.tag} ${item.tag.replace(/\s/g, "")} ${item.source} ${item.scope ?? ""}`.toLowerCase();
            return terms.every(term => search.includes(term)) || Boolean(abbreviated && item.kind.toLowerCase().startsWith(abbreviated[1]) &&
                item.tag.endsWith(` ${abbreviated[2]}>`));
        });
        if (menu.signature === signature && !menu.hidden) {
            popupPosition(menu, anchor, 350);
            return;
        }
        menu.signature = signature;
        selected = 0;
        const rows = suggestions.map((item, index) => {
            const row = button("", () => choose(item), "hsd-token-option");
            row.id = `${menu.id}-${index}`;
            row.setAttribute("role", "option");
            row.tabIndex = -1;
            row.onmousedown = event => event.preventDefault();
            row.onmousemove = () => { selected = index; markActive(); };
            const info = node("span", "hsd-token-label");
            info.append(node("strong", "", item.tag), node("span", "", item.source),
                node("small", "", `${item.kind} · ${item.assign ? `Assign · ${item.scope}` : "Assigned to this pass"}`));
            const media = previewMedia(item, true);
            row.append(...(media ? [media, info] : [info]));
            return row;
        });
        menu.replaceChildren(...(rows.length ? rows : [node("p", "hsd-note", "No matching reference for this pass.")]));
        markActive();
        popupPosition(menu, anchor, 350);
    };

    area.addEventListener("input", () => {
        context.write(area.value);
        if (!composing) suggest();
    });
    area.addEventListener("compositionstart", () => { composing = true; closeMenu(); });
    area.addEventListener("compositionend", () => { composing = false; suggest(); });
    area.addEventListener("click", suggest);
    area.addEventListener("select", setCursor);
    area.addEventListener("focus", setCursor);
    area.addEventListener("blur", closeMenu);
    area.addEventListener("scroll", () => {
        align();
        closeHover();
        if (!menu.hidden || document.activeElement === area) suggest();
    });
    area.addEventListener("keyup", event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) suggest();
        else setCursor();
    });
    area.addEventListener("keydown", event => {
        if (menu.hidden || event.isComposing) return;
        const key = event.key;
        if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(key) || event.shiftKey && key === "Tab") return;
        if (!suggestions.length && key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (key === "Escape") {
            dismissed = menu.signature;
            closeMenu();
        } else if (key === "Enter" || key === "Tab") choose(suggestions[selected]);
        else {
            selected = (selected + (key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
            markActive(true);
        }
    });
    area.onmousemove = event => {
        if (!menu.hidden) return;
        const match = Array.from(painted.querySelectorAll(".hsd-mark-reference")).find(span => span.reference?.url &&
            Array.from(span.getClientRects()).some(rect => event.clientX >= rect.left && event.clientX <= rect.right &&
                event.clientY >= rect.top && event.clientY <= rect.bottom));
        if (match === hovered) return;
        closeHover();
        if (!match) return;
        hovered = match;
        hover.append(node("strong", "", `${match.reference.tag} · ${match.reference.source}`), previewMedia(match.reference));
        popupPosition(hover, match.getBoundingClientRect(), 260);
    };
    area.onmouseleave = hover.onmouseleave = () => { hoverTimer = setTimeout(closeHover, 180); };
    hover.onmouseenter = () => clearTimeout(hoverTimer);
    root.onfocusout = event => { if (!root.contains(event.relatedTarget)) closeHover(); };
    const resetPanel = () => { builder.hidden = true; builder.replaceChildren(); };
    builder.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        resetPanel();
        area.focus();
        area.setSelectionRange(cursor, cursor);
    });
    const open = type => {
        const saved = cursor;
        resetPanel();
        closeHover();
        builder.hidden = false;
        const dismiss = () => { resetPanel(); area.focus(); area.setSelectionRange(saved, saved); };
        const accept = (result, extra) => { resetPanel(); apply(result.value, result.cursor, extra); };
        if (type === "dialogue") dialoguePanel(builder, context, saved, area, accept, dismiss);
        else shotPanel(builder, context, saved, area, accept, dismiss);
    };
    if (narrative) {
        const dialogue = button("Insert Dialogue", () => open("dialogue"));
        dialogue.disabled = !context.languages.length;
        if (dialogue.disabled) dialogue.title = "Enable Fantastic PromptBuilder to load its supported languages.";
        tools.append(dialogue, button("Insert Shot", () => open("shot")));
    }
    root.refreshPrompt = () => {
        if (area.value !== context.read()) area.value = context.read();
        repaint();
    };
    const observer = new ResizeObserver(align);
    observer.observe(area);
    const inspector = mount.closest(".hsd-scroll") ?? context.scrollContainer;
    const onScroll = () => {
        closeHover();
        if (!menu.hidden) suggest();
    };
    inspector?.addEventListener("scroll", onScroll);
    root.disposePrompt = () => {
        observer.disconnect();
        inspector?.removeEventListener("scroll", onScroll);
        closeHover();
    };
    area.addEventListener("pointerdown", closeHover);
    repaint();
    return root;
}

function draftReferences(panel, context, fields) {
    const slots = context.slots().filter(slot => !slot.missing);
    if (!slots.length) return;
    let target = fields[0];
    for (const field of fields) field.addEventListener("focus", () => { target = field; });
    const picker = control(panel, "Insert an assigned reference", "", [["", "Choose a token"], ...slots.map(slot => [slot.tag, `${slot.tag} · ${slot.source}`])], () => {
        if (!picker.value) return;
        const { value, cursor } = insertPrompt(target.value, target.selectionStart, target.selectionStart, picker.value);
        target.value = value;
        picker.value = "";
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.focus();
        target.setSelectionRange(cursor, cursor);
    });
}

function builderFooter(panel, insert, close) {
    const preview = node("pre", "hsd-built-prompt");
    preview.setAttribute("aria-label", "Generated syntax");
    const warning = node("p", "hsd-note hsd-tool-warning");
    warning.setAttribute("role", "status");
    const actions = node("div", "hsd-actions");
    const insertButton = button("Insert at cursor", insert, "hsd-primary");
    actions.append(insertButton, button("Cancel", close));
    panel.append(node("strong", "", "Generated syntax"), preview, warning, actions);
    return { preview, warning, actions, insertButton };
}

function dialoguePanel(panel, context, cursor, area, accept, close) {
    const speakers = new Map(context.speakers());
    const selected = new Set(speakers.size ? [speakers.keys().next().value] : []);
    const newIds = new Set();
    const speakerList = node("div", "hsd-speaker-list");
    const grid = node("div", "hsd-grid");
    const language = control(grid, "Language", "English", context.languages, update);
    const cut = control(grid, "Dialogue across a cut", "", [["", "Stays in this shot"], ["out", "Continues into the next shot"],
        ["in", "Carries over from the previous shot"], ["both", "Carries over and continues"]], update);
    const voiceover = control(grid, "Off-screen voiceover", false, "checkbox", update);
    const singing = control(grid, "Singing", false, "checkbox", update);
    const punctuation = control(grid, "If punctuation is missing", ".", [[".", "Period"], ["?", "Question mark"], ["!", "Exclamation mark"]], update);
    const words = control(panel, "Spoken words", "", "textarea", update);
    words.placeholder = "Write the actual words. Use [unclear] for unintelligible spans.";
    const action = control(panel, "Visible event or character action", "", "text", update);
    action.placeholder = "She places a cup on the counter";
    const delivery = control(panel, "Delivery, emotion and speaking style", "", "text", update);
    delivery.placeholder = "in a quiet, warm voice";
    draftReferences(panel, context, [action, delivery]);
    const audioSlots = context.slots().filter(slot => slot.kind === "Audio" && !slot.missing);
    const audioGrid = node("div", "hsd-grid");
    const audio = control(audioGrid, "Assigned audio reference", "", [["", "None"], ...audioSlots.map(slot => [slot.tag, `${slot.tag} · ${slot.source}`])], update);
    const behavior = control(audioGrid, "Audio reference behavior", "reference", [["reference", "Reference delivery"],
        ...context.audioBehaviors.map(marker => [marker, marker])], update);
    const addSpeaker = () => {
        let n = 1;
        while (speakers.has(`S${n}`)) n++;
        const id = `S${n}`;
        speakers.set(id, "");
        selected.add(id);
        newIds.add(id);
        showSpeakers();
        update();
        speakerList.lastElementChild?.querySelector("input[type=text]")?.focus();
    };
    const header = node("div", "hsd-sectionbar");
    header.append(node("strong", "", "Dialogue Builder"), node("span", "hsd-spacer"), button("New speaker", addSpeaker));
    panel.prepend(header, speakerList, grid);
    if (audioSlots.length) panel.append(audioGrid);
    const footer = builderFooter(panel, () => {
        const built = result();
        if (!built.text) return;
        accept(insertPrompt(area.value, cursor, cursor, built.text), {
            speakers: Object.fromEntries([...speakers].filter(([id, name]) => name || selected.has(id) || !newIds.has(id))),
            audio: audio.value, behavior: behavior.value,
        });
    }, close);

    function showSpeakers() {
        speakerList.replaceChildren();
        for (const [id, name] of speakers) {
            const row = node("div", "hsd-speaker");
            const check = control(row, `(${id})`, selected.has(id), "checkbox", () => {
                if (check.checked) selected.add(id);
                else selected.delete(id);
                update();
            });
            const input = control(row, `Name for ${id}`, name, "text", () => { speakers.set(id, input.value.trim()); update(); });
            input.maxLength = 120;
            speakerList.append(row);
        }
        if (!speakers.size) speakerList.append(node("p", "hsd-note", "Create a speaker to identify the voice in the prompt."));
    }

    function result() {
        const ids = [...speakers.keys()].filter(id => selected.has(id));
        const names = ids.length && ids.every(id => speakers.get(id)) ? ids.map(id => speakers.get(id)).join(" and ") : "";
        return buildDialogue({ speakers: ids, names, language: language.value, words: words.value, action: action.value,
            delivery: delivery.value, voiceover: voiceover.checked, singing: singing.checked, punctuation: punctuation.value,
            cut: cut.value, audio: audio.value, behavior: behavior.value });
    }

    function update() {
        const built = result();
        behavior.disabled = !audio.value;
        const retention = audio.value && context.audioRule(audio.value, behavior.value);
        footer.preview.textContent = !built.text || !retention ? built.text :
            `${built.text}\n\n${audio.value}: ${behavior.value} - ${retention.note}`;
        footer.insertButton.disabled = !built.text;
        const notes = [...built.warnings];
        if (cut.value) notes.push("Use Dialogue Builder on the other side of the cut to place the matching transition marker.");
        if (behavior.value === "fully_copy" && audio.value) notes.push("Full copy asks H3 to reuse the entire reference soundtrack.");
        if (retention?.changesRule) notes.push(`This changes the existing retention rule for ${audio.value}.`);
        footer.warning.textContent = notes.join(" ");
    }
    showSpeakers();
    update();
    words.focus();
}

function shotPanel(panel, context, cursor, area, accept, close) {
    const shots = shotList(area.value);
    const previous = shots.filter(shot => shot.position < cursor);
    const next = previous.length ? previous.at(-1).number + 1 : 1;
    const frame = Math.max(1, (previous.at(-1)?.frame || 0) + 1);
    const grid = node("div", "hsd-grid");
    const number = control(grid, "Shot number", next, "number", update);
    number.min = 1;
    const time = control(grid, "Cut time · seconds or MM:SS.mmm", next === 1 ? "0" : formatCut(frame), "text", update);
    const transition = control(grid, "Transition", "cut", [["cut", "Hard cut"], ["dissolve", "Dissolve"], ["fade", "Fade"],
        ["wipe", "Wipe"], ["custom", "Custom"]], update);
    const custom = control(panel, "Custom transition wording", "", "text", update);
    const description = control(panel, "Shot description", "", "textarea", update);
    const descriptions = node("div", "hsd-grid");
    const framing = control(descriptions, "Camera framing", "", "text", update);
    const movement = control(descriptions, "Camera movement", "", "text", update);
    const action = control(descriptions, "Subject action", "", "text", update);
    const audio = control(descriptions, "Audio continues across the cut", false, "checkbox", update);
    const renumber = control(descriptions, "Renumber shot markers on insert", false, "checkbox", update);
    panel.prepend(node("strong", "", "Shot Builder"), node("p", "hsd-note", `${context.frames()} frames at 24 fps. Times snap to the nearest frame. Describe small reframing or continuous camera motion within the same shot.`), grid);
    panel.append(descriptions);
    draftReferences(panel, context, [description, framing, movement, action]);
    const footer = builderFooter(panel, () => {
        const built = result();
        if (built.text && !built.warnings.length) accept(built.result);
    }, close);
    if (shots.some((shot, index) => shot.number !== index + 1)) {
        footer.actions.append(button("Renumber existing markers", () => accept(renumberShots(area.value, cursor))));
    }

    function result() {
        const displayNumber = renumber.checked ? previous.length + 1 : +number.value;
        return buildShot({ number: displayNumber, time: displayNumber === 1 ? "0" : time.value, transition: transition.value,
            custom: custom.value, description: description.value, framing: framing.value, movement: movement.value,
            action: action.value, audio: audio.checked, renumber: renumber.checked }, area.value, cursor, context.frames());
    }

    function update() {
        const opening = (renumber.checked ? previous.length + 1 : +number.value) === 1;
        number.disabled = renumber.checked;
        time.disabled = transition.disabled = audio.disabled = opening;
        custom.parentElement.hidden = opening || transition.value !== "custom";
        const built = result();
        footer.preview.textContent = built.text;
        footer.warning.textContent = [...built.warnings, ...(renumber.checked ? ["Renumbering changes shot markers. Review mentions and ending-shot settings after inserting."] : [])].join(" ");
        footer.insertButton.disabled = !built.text || built.warnings.length > 0;
    }
    update();
    description.focus();
}

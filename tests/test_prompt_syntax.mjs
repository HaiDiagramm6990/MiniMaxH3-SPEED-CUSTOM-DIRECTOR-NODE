import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceSlots } from "../web/fantastic.js";
import { buildDialogue, buildShot, insertPrompt, promptMarks, rebaseReferences, referenceFragment, renumberShots,
    shotList, shotWarnings, speakerIds, subjectSlots } from "../web/prompt-syntax.js";

test("reference syntax and subject names match positional slots", () => {
    const assets = [{ id: "still-a", kind: "image", name: "Ada" }, { id: "still-b", kind: "image", name: "Bo" },
        { id: "clip", kind: "video", has_audio: true, name: "Interview" }, { id: "track", kind: "audio", name: "Song" }];
    const pass = { mode: "generate", builder: { ref: { subjectDefs: [{ text: "<Subject 1> is in <Picture 1>.", name: "Ada" }] } } };
    const scene = { generation: "REF", transition: "cut", references: ["still-a", "still-b"],
        videos: [{ asset: "clip", audio_mode: "paired" }], audios: ["track"] };
    const before = referenceSlots({}, scene, pass, assets);
    assert.deepEqual(before.map(slot => slot.tag), ["<Picture 1>", "<Picture 2>", "<Audio 1>", "<Video 1>", "<Audio 2>"]);
    assert.equal(subjectSlots(pass, before)[0].asset.name, "Ada");
    const after = referenceSlots({}, { ...scene, references: ["still-b", "still-a"], videos: [] }, pass, assets);
    assert.equal(rebaseReferences("<Picture 1> <Picture 2> <Audio 2> <Video 1>", before, after),
        "<Picture 2> <Picture 1> <Audio 1> [Missing reference: Interview]");
    assert.deepEqual(referenceFragment("Before <pic1 after", 12, 12), { query: "pic1", start: 7, end: 12 });
    assert.deepEqual(referenceFragment("Before <Picture 1> after", 11, 11), { query: "pic", start: 7, end: 18 });
    const result = promptMarks("<picture1> <Picture 1> <Picture 3>", before, 39, ["English"], true);
    assert.deepEqual(result.marks.map(mark => mark.kind), ["warning", "reference", "warning"]);
});

test("dialogue preserves words and inserts one or multiple speaker IDs", () => {
    const form = { speakers: ["S1", "S2"], names: "Ada and Bo", language: "English", words: "Yes, [unclear] right?",
        voiceover: true, singing: true, cut: "both", action: "They nod", delivery: "quietly", audio: "<Audio 1>", behavior: "partially_copy" };
    const result = buildDialogue(form);
    assert.match(result.text, /They nod\. The shared voice of Ada and Bo \(S1,S2\) says in an off-screen voiceover with a sung delivery quietly: <scenetrans> <d>\[English\] Yes, \[unclear\] right\?<\/d> while their lips remain completely closed\. <scenetrans>/);
    assert.deepEqual(speakerIds(result.text), ["S1", "S2"]);
    assert.match(buildDialogue({ ...form, words: "All aboard", cut: "" }).text, /All aboard\.<\/d>/);
    assert.match(buildDialogue({ ...form, words: "Ready", cut: "", punctuation: "?" }).text, /Ready\?<\/d>/);
    assert(buildDialogue({ ...form, words: "Yes!! 😃" }).warnings.length);
    assert.equal(buildDialogue({ ...form, words: "<Picture 1>" }).text, "");
    assert.equal(insertPrompt("BeforeAfter", 6, 6, "Dialogue.").value, "Before Dialogue. After");
});

test("shot placement follows native 24 fps, leaving surrounding prose intact", () => {
    const form = { number: 2, time: "00:03.500", transition: "cut", custom: "", audio: true,
        framing: "a close-up", description: "the face", movement: "The camera tilts up", action: "She nods", renumber: false };
    const opening = "[Shot 1] Wide view.";
    const result = buildShot(form, `${opening}\n\nTail text.`, opening.length, 90);
    assert.equal(result.warnings.length, 0);
    assert.match(result.result.value, /\[Shot 2\] At 00:03\.500, the camera cuts to a close-up showing the face\./);
    assert(result.result.value.endsWith("Tail text."));
    assert(buildShot(form, opening, opening.length, 84).warnings.length);
    assert(buildShot({ ...form, time: "00:03.500-00:04.000" }, opening, opening.length, 120).warnings.length);
    const sameFrame = `${opening}\n[Shot 2] At 00:03.500, At the gate.`;
    assert(buildShot({ ...form, number: 3, time: "3.51" }, sameFrame, sameFrame.length, 90).warnings.some(note => note.includes("24 fps")));
    assert(shotWarnings(shotList(`${sameFrame}\n[Shot 2] At 00:03.625, The sail moves.`), 90).some(note => note.includes("duplicated")));
    assert.match(buildShot({ ...form, number: 1, time: "0" }, "", 0, 90).text, /^\[Shot 1\] (?!At)/);
    const jumped = `${opening}\n[Shot 3] At 00:03.500, A gate referencing [Shot 1].`;
    assert.equal(shotWarnings(shotList(jumped), 90).length, 1);
    assert.match(renumberShots(jumped).value, /\[Shot 2\] At .*referencing \[Shot 1\]/);
});

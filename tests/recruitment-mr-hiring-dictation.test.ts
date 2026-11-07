import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The owner, 7 Nov 2026: "in all the comments section in this module … make the same mic [as the Phoenix
// CRM visit form] so I can talk and it is written instead of me typing."

import { appendDictated } from "../src/lib/phoenix-crm/dictation.ts";
import { MR_DICTATE_LABEL, mrDictationMessage } from "../src/lib/recruitment/mr-hiring/dictation.ts";
import { MR_BOOKING_NOTES_LIMIT, MR_COMMENT_LIMIT } from "../src/lib/recruitment/mr-hiring/vocabulary.ts";
import { stripComments } from "./support/comment-strip.ts";

const codeOnly = (path: string) => stripComments(readFileSync(path, "utf8"));

export function runRecruitmentMrHiringDictationTests() {
  // EVERY comment box of the module carries the microphone — a new box without one fails here.
  const forms = codeOnly("src/components/recruitment/mr-hiring/mr-forms.tsx");
  const boxes = forms.match(/<textarea\b/g) ?? [];
  const mics = forms.match(/<MrDictate\b/g) ?? [];
  assert.ok(boxes.length >= 3, "the result comment, the recommendation note and the interviewer's notes are all here");
  assert.equal(mics.length, boxes.length, "every comment box in Medical Rep hiring has the microphone under it");
  for (const [setter, limit] of [
    ["setComment", "MR_COMMENT_LIMIT"],
    ["setNote", "MR_COMMENT_LIMIT"],
    ["setNotes", "MR_BOOKING_NOTES_LIMIT"],
  ]) {
    assert.match(
      forms,
      new RegExp(`onAppend=\\{\\(spoken\\) => ${setter}\\(\\(current\\) => appendDictated\\(current, spoken, ${limit}\\)\\)\\}`),
      `${setter}: the spoken words are APPENDED to what was typed, within the box's own cap`,
    );
  }

  // THE SAME MIC as the CRM visit form: its engine, not a second one.
  const mic = codeOnly("src/components/recruitment/mr-hiring/mr-dictate.tsx");
  assert.match(mic, /startDictation\(/, "the CRM visit form's own speech engine");
  assert.match(mic, /useSyncExternalStore\(noSubscribe, isDictationSupported, \(\) => false\)/, "no microphone is drawn where the browser has no engine");
  assert.doesNotMatch(mic, /MediaRecorder|startRecording|getUserMedia/, "it writes words; it records nothing");
  assert.equal(MR_DICTATE_LABEL, "Speak");

  // Nothing is recorded here, so no sentence may promise a recording; each names the way out.
  for (const code of ["language-not-supported", "not-allowed", "audio-capture", "network"]) {
    const message = mrDictationMessage(code);
    assert.doesNotMatch(message, /record/i, `${code}: never says a recording is kept`);
    assert.match(message, /type the comment/i, `${code}: typing is always the way out`);
  }

  // Appended within the cap, never replacing.
  assert.equal(appendDictated("Good communication.", " يتكلم بثقة ", MR_COMMENT_LIMIT), "Good communication. يتكلم بثقة");
  assert.equal(appendDictated("x".repeat(MR_BOOKING_NOTES_LIMIT), "more", MR_BOOKING_NOTES_LIMIT).length, MR_BOOKING_NOTES_LIMIT, "a full box stays as it was");
}

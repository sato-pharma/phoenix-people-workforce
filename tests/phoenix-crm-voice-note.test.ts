import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";
import { extensionFor, formatSeconds, MAX_SECONDS, rejectRecording, VOICE_MAX_BYTES } from "../src/lib/phoenix-crm/voice-recorder.ts";
import { voicePathTerritory } from "../src/lib/phoenix-crm/server/voice-notes.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM — the visit's spoken note (owner, 2026-09-25).
//
// A rep standing outside a clinic can say in twenty seconds what he will not type in two minutes, and
// in Egyptian Arabic the keyboard is the slow part. This keeps the AUDIO, which is the whole difference
// from the dictation shipped the same night, where the speech goes to Google or Apple as it is spoken and
// what saves is text. They sit on the same form and the one thing that must never happen is the two being
// described, stored or scored as one another.
//
// ON MOST BROWSERS NOTHING READS THE STORED FILE, AND ON ONE KIND SOMETHING DOES. Firefox has no speech
// engine at all, so there the finished recording is written out by Phoenix's own server
// (src/lib/phoenix-crm/server/voice-transcribe.ts, added the same day on the owner's "un browsers must be
// text and audio"). That is a SECOND engine in a SECOND module behind a SECOND route — never a change to
// anything pinned in this file, and the sweep below is what keeps it out of the audio's own path.
//
// What is pinned here is what has no other alarm:
//
//   1. THE NOTE DATES NOTHING. The owner's ruling, and it is kept structurally rather than by comment:
//      phoenix_crm_take_voice returns void where its photo sibling returns the issue time that becomes
//      captured_at, the slot answer carries no time, and nothing the phone sends up holds one either.
//      (The migration's half of this is pinned in phoenix-crm-boundary.test.ts, beside the photo's.)
//   2. THE PATH IS THE ONLY THING TRUSTED. Seconds and bytes are labels on a play button, so they are
//      clamped rather than believed — and they are dropped entirely when there is no path to describe,
//      which is what stops a payload with figures and no recording reaching the database at all.
//   3. THE HALVES DO NOT FEED EACH OTHER. Since 2026-09-25 both run from ONE button (owner: "I speak
//      once and this speaking appears in the field as a text and saved as a record. Both."), so the
//      wording that kept them apart is no longer two sentences on two controls — it is one control
//      saying which of the two to believe. Where the browser has an engine the words come from it
//      listening live and the stored audio is read by nothing; where it has none they come from the
//      stored audio itself. Pinned structurally below, and in words in phoenix-crm-speak.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const RECORDER = "src/lib/phoenix-crm/voice-recorder.ts";
const SERVER = "src/lib/phoenix-crm/server/voice-notes.ts";
const CONTROL = "src/components/phoenix-crm/speak.tsx";
const PLAYER = "src/components/phoenix-crm/voice-playback.tsx";
const FORM = "src/components/phoenix-crm/visits-tab.tsx";

function recording(over: { seconds?: number; bytes?: number; mimeType?: string } = {}) {
  const bytes = over.bytes ?? 64 * 1024;
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: over.mimeType ?? "audio/webm" }),
    mimeType: over.mimeType ?? "audio/webm",
    seconds: over.seconds ?? 12,
  };
}

/** A visit payload the phone would send, with the voice fields under test overridden. */
function body(over: Record<string, unknown>) {
  return {
    customerId: "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b",
    kind: "single",
    products: ["Lacto Advanced"],
    pharmacyName: "El Ezaby",
    comment: "قابلت الدكتور",
    photoPath: "seat-1/2026/09/0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b.jpg",
    lat: 30.0444,
    lon: 31.2357,
    accuracyMeters: 12,
    deviceCapturedAt: "2026-09-25T09:00:00.000Z",
    ...over,
  };
}

const VOICE_PATH = "seat-1/2026/09/0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b.webm";

export function runPhoenixCrmVoiceNoteTests() {
  // ── The container the browser gave us decides the extension ───────────────────
  // The slot is issued BEFORE the recording exists, so the server cannot know which container the
  // phone will produce — unlike the photo slot, which hardcodes .jpg because a camera gives one format.
  assert.equal(extensionFor("audio/webm;codecs=opus"), ".webm", "Chrome and Firefox");
  assert.equal(extensionFor("audio/mp4"), ".m4a", "Safari");
  assert.equal(extensionFor("audio/ogg;codecs=opus"), ".ogg");
  assert.equal(extensionFor("audio/mpeg"), ".mp3");
  assert.equal(extensionFor("audio/unknown-thing"), ".webm", "an unknown container still gets a path rather than no note");

  // Every extension the recorder can name is one the server's path check accepts. Stated as the
  // round trip rather than as two lists, because two lists are what drift: a recorder that learns a
  // fifth container would otherwise issue paths that no reader could later place in a territory.
  for (const mimeType of ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/mpeg"]) {
    const extension = extensionFor(mimeType);
    const path = `seat-1/2026/09/0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b${extension}`;
    assert.deepEqual(
      voicePathTerritory(path),
      { seatSegment: "seat-1", isTest: false },
      `${mimeType} records as ${extension}, and the server can place that path in its territory`,
    );
  }

  // ── A tap on the microphone is not a note ─────────────────────────────────────
  // Opening and closing the microphone produces a container header and no speech. Saving it costs a
  // row, a storage object and a reviewer's time opening silence.
  assert.equal(rejectRecording(recording()), null, "a normal note is kept");
  assert.match(String(rejectRecording(recording({ seconds: 0 }))), /too short/i);
  assert.match(String(rejectRecording(recording({ bytes: 200 }))), /too short/i, "a header with no speech in it is too short whatever the clock says");
  assert.match(String(rejectRecording(recording({ bytes: VOICE_MAX_BYTES + 1 }))), /larger than Phoenix accepts/i);
  assert.equal(rejectRecording(recording({ bytes: VOICE_MAX_BYTES })), null, "the cap itself is allowed — the bucket refuses only above it");

  assert.equal(formatSeconds(0), "0:00");
  assert.equal(formatSeconds(9), "0:09", "the clock never reads 0:9");
  assert.equal(formatSeconds(MAX_SECONDS), "1:00");

  // ── A path belongs to a territory, or to nothing ──────────────────────────────
  assert.deepEqual(voicePathTerritory(VOICE_PATH), { seatSegment: "seat-1", isTest: false });
  assert.deepEqual(voicePathTerritory(`test/${VOICE_PATH}`), { seatSegment: "seat-1", isTest: true }, "a Super Admin's test note is marked as one");
  assert.equal(voicePathTerritory("seat-1/2026/09/not-a-uuid.webm"), null);
  assert.equal(voicePathTerritory(VOICE_PATH.replace(".webm", ".jpg")), null, "a photo's extension is not a voice note's");
  assert.equal(voicePathTerritory("seat-1/2026/0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b.webm"), null, "a path of the wrong depth places nobody");

  // ── The path is trusted; the two figures are not ──────────────────────────────
  {
    const draft = parseVisitDraft(body({ voiceNotePath: VOICE_PATH, voiceNoteSeconds: 18, voiceNoteBytes: 96_000 }));
    assert.ok(draft.ok, "a visit with a voice note is a valid draft");
    assert.equal(draft.value.voiceNotePath, VOICE_PATH);
    assert.equal(draft.value.voiceNoteSeconds, 18);
    assert.equal(draft.value.voiceNoteBytes, 96_000);
  }
  {
    // Figures with no recording behind them. Keeping them would put a duration on a visit that has no
    // note, which is a play button the review screen cannot honour.
    const draft = parseVisitDraft(body({ voiceNoteSeconds: 18, voiceNoteBytes: 96_000 }));
    assert.ok(draft.ok);
    assert.equal(draft.value.voiceNotePath, null);
    assert.equal(draft.value.voiceNoteSeconds, null, "no path, no duration");
    assert.equal(draft.value.voiceNoteBytes, null, "no path, no size");
  }
  {
    // The recorder caps at 60s and the column allows 120, so a longer claim is clamped rather than
    // refused: the audio is already stored and the figure beside it is a label, not a gate.
    const draft = parseVisitDraft(body({ voiceNotePath: VOICE_PATH, voiceNoteSeconds: 99_999, voiceNoteBytes: 99_999_999 }));
    assert.ok(draft.ok);
    assert.equal(draft.value.voiceNoteSeconds, 120);
    assert.equal(draft.value.voiceNoteBytes, 2 * 1024 * 1024);
  }
  {
    const draft = parseVisitDraft(body({ voiceNotePath: VOICE_PATH, voiceNoteSeconds: "not a number", voiceNoteBytes: -4 }));
    assert.ok(draft.ok, "a nonsense figure drops the label, never the note");
    assert.equal(draft.value.voiceNotePath, VOICE_PATH);
    assert.equal(draft.value.voiceNoteSeconds, null);
    assert.equal(draft.value.voiceNoteBytes, null);
  }

  // ── Nothing about the note carries a time ─────────────────────────────────────
  // The owner's ruling, and the one rule on this feature that cannot be seen on any screen. Asserted on
  // the code rather than the prose, because the comments explaining the absence necessarily name it.
  const control = stripComments(readFileSync(CONTROL, "utf8"));
  const player = stripComments(readFileSync(PLAYER, "utf8"));
  assert.doesNotMatch(control, /\bissuedAt\b|deviceCapturedAt|capturedAt/, `${CONTROL} sends no time with the recording — the photo dates the visit and this does not`);
  const form = stripComments(readFileSync(FORM, "utf8"));
  assert.match(form, /voiceNotePath:\s*voiceNote\?\.path\s*\?\?\s*null/, `${FORM} sends the note's path`);
  assert.doesNotMatch(form, /voiceNote\w*(?:At|Time|Clock)\b/, `${FORM} sends no time belonging to the note`);

  // ── The recording is stored when it stops, not when the visit saves ───────────
  // So the save carries a path rather than two megabytes on a weak signal, and so the rep learns the
  // upload failed while still standing where they can record it again.
  assert.match(control, /"\/api\/phoenix-crm\/voice\/upload-slot"/, `${CONTROL} asks for its own slot, never the photo's`);
  assert.doesNotMatch(control, /photos\/upload-slot/, `${CONTROL} never reaches the photo route — a recording is not evidence of presence`);
  assert.match(control, /method:\s*"PUT"/, `${CONTROL} puts the audio to the slot itself`);

  // ── The microphone is handed back on every exit ───────────────────────────────
  // A live track is a microphone the phone still considers in use, and the OS says so in the status bar
  // long after the form thinks it has finished.
  const recorder = stripComments(readFileSync(RECORDER, "utf8"));
  assert.match(recorder, /recorder\.state\s*!==\s*"inactive"/, `${RECORDER} stops a PAUSED recorder too — a backgrounded tab pauses rather than stops, and "nothing to stop" is what leaves the mic open`);
  assert.match(control, /recorder\.current\?\.cancel\(\)/, `${CONTROL} releases the microphone when the screen goes`);

  // ── The audio path itself still meets no speech engine ────────────────────────
  // NARROWED 2026-09-25, in the same day's second change, and the narrowing is the point. A browser with
  // no speech engine of its own (Firefox) now DOES have the stored recording written out — by
  // src/lib/phoenix-crm/server/voice-transcribe.ts, which is its own module reached by its own route. So
  // "nothing ever transcribes a recording" is no longer true and must not be asserted; what is asserted
  // is that the audio's OWN path — the recorder, the slot server that mints and signs it, and the player
  // — carries no recogniser and no transcription, so the second engine cannot be reached by accident from
  // any of the three. It is one extra import away and that import is what this sweep refuses.
  //
  // The control is not in the sweep either: since the halves were merged onto one button it hosts the
  // live engine, so a "no recogniser here" check over it would be red for a correct file.
  assert.doesNotMatch(
    stripComments(readFileSync(SERVER, "utf8")) + recorder + player,
    /SpeechRecognition|webkitSpeech|transcri/i,
    "the slot server, the recorder and the player hold no speech engine and no transcription — the second engine lives in its own module, so no screen or storage path can reach it sideways",
  );

  // And inside the one control the halves stay apart: the engine hands back TEXT, which goes to the
  // comment, and the recorder hands back a stored PATH, which goes to the payload. Neither is derived
  // from the other, so a bug can lose a half — never turn one into the other.
  assert.match(
    control,
    /onFinal:\s*\(text\)\s*=>\s*\{\s*onAppend\(text\)/,
    `${CONTROL} sends the engine's words to the comment and nothing else`,
  );
  assert.match(
    control,
    /onChange\(\{\s*path:\s*slot\.path/,
    `${CONTROL} sends the recording to the payload as the stored path — never as text`,
  );

  // ── A note nobody can play is a write-only feature ────────────────────────────
  // The bucket is private, so hearing a note means signing a link for it. Three things are pinned, and
  // each is a way the playback half goes wrong while every screen still renders.
  assert.match(player, /"\/api\/phoenix-crm\/voice\/sign"/, `${PLAYER} signs through the voice route`);
  assert.doesNotMatch(player, /photos\/sign/, `${PLAYER} never signs through the photo route — a voice path is not a photo path and the two buckets are not the same bucket`);

  // It signs the ONE note the reader pressed, rather than joining a batch the way the photo thumb does.
  // A day's list can hold twenty notes nobody opens, and signing them on render hands out twenty live
  // URLs into a private bucket to answer a question nobody asked.
  assert.match(player, /paths:\s*\[path\]/, `${PLAYER} asks for the note it was pressed on, not for every note on the screen`);

  // Reading a visit must not reach the microphone. Kept by the player being its own file: a screen that
  // only listens does not import the recorder, so it cannot open a device by a stray render.
  assert.doesNotMatch(player, /getUserMedia|MediaRecorder|startRecording/, `${PLAYER} holds no recorder — a reviewer's screen never opens a microphone`);
  assert.doesNotMatch(player, /\bissuedAt\b|capturedAt/, `${PLAYER} carries no time — playback is not a second place for a capture time to appear`);

  // ── And it is actually mounted, on both readings of a day ─────────────────────
  // The recorder and the route can both be correct while nothing on any screen plays anything, which is
  // how this feature stood for an afternoon. Every mount is guarded by the row's own path, so a visit
  // with no note shows no control rather than one that opens nothing.
  // Stated as a floor and a ratio rather than as one exact count, because an exact count is satisfied by
  // the wrong two mounts and — worse — makes the ratio below unreachable: a third, unguarded player
  // would fire the count and never the guard, leaving the rule that actually matters unproven.
  const mounts = [...form.matchAll(/<CrmVoiceNotePlayer\b/g)].length;
  assert.ok(mounts >= 2, `${FORM} plays the note on the card AND in the table — a note stored and never played is a write-only feature (found ${mounts})`);
  assert.equal(
    [...form.matchAll(/visit\.voiceNotePath \?/g)].length,
    mounts,
    `${FORM} renders a player only where the row has a path — an unguarded one is a control that opens nothing`,
  );

  // It is shown beside the comment and never beside the photo: it is the comment said rather than
  // typed, while the photo is the evidence of presence. Handing a recording to the control that stands
  // for "this is where they were" is the visual half of the rule the database keeps structurally.
  assert.doesNotMatch(form, /<CrmPhotoThumb[\s\S]{0,200}?voiceNote/, `${FORM} never hands a voice path to the photo thumb`);

  // ── There is ONE control, and the form mounts it once ─────────────────────────
  // The owner asked for one option, not two sitting together. Two mounts would be the old shape back
  // by accident, and each one opens its own microphone.
  assert.equal(
    [...form.matchAll(/<CrmSpeak\b/g)].length,
    1,
    `${FORM} mounts one spoken-comment control — the owner asked for a single button, and a second one would open a second microphone`,
  );
  assert.doesNotMatch(form, /<CrmDictate\b|<CrmVoiceNote\b/, `${FORM} no longer carries the two controls the one replaced`);
}

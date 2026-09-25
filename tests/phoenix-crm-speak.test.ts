import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  speakAccuracyLine,
  speakAgainLine,
  speakBlockedMessage,
  speakHalves,
  speakLiveHint,
  speakLiveLabel,
  speakPartialMessage,
  speakProcessorLine,
  speakPromise,
  speakSupported,
  SPEAK_AGAIN_LABEL,
  SPEAK_LABEL,
  type SpeakHalves,
} from "../src/lib/phoenix-crm/speak.ts";
import { MAX_SECONDS } from "../src/lib/phoenix-crm/voice-recorder.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM — ONE control for the spoken visit comment (owner, 2026-09-25).
//
// "I want the only one option dictate and record in the same time. I speak once and this speaking
// appears in the field as a text and saved as a record. Both." One press, one microphone, both halves:
// the browser's speech engine writes words into the comment as they settle, and MediaRecorder keeps
// the audio, which uploads when he stops.
//
// WHAT THIS FILE EXISTS TO STOP. The two halves look like one thing on the screen and are not one
// thing in the code, and the tempting simplification — "the text is the transcript of the recording" —
// is FALSE and would be believed. The engine listens live and can mishear Egyptian Arabic; the stored
// audio is read by no speech service at any point. So the text can be wrong where the recording is
// right, and the control has to say which one to trust. Everything below is that rule, in three parts:
//
//   1. THE WORDING IS PURE AND PINNED. Every sentence the rep reads comes from a function here rather
//      than from JSX, so a later tidy-up of the component cannot quietly change what he was promised.
//   2. IT PROMISES ONLY WHAT THE BROWSER HAS. Firefox has a recorder and no speech engine at all. A
//      button promising "both" on a browser that can do one of them is copy a rep discovers at a
//      clinic door, so each line is chosen from the halves that actually work.
//   3. THE PROCESSOR NOTICE STAYS ON THE CONTROL. The owner's ruling the same day — "add the processor
//      line to the dictation mic, not the privacy page" — and it names Google, Apple, Chrome and
//      Safari, because "sent to a third party" is nothing a rep can act on.
//
// The recording's own rules (its path, its clamped figures, that nothing dates it, that no recogniser
// touches the stored file) are pinned in phoenix-crm-voice-note.test.ts, which reads this same control.
// ─────────────────────────────────────────────────────────────────────────────

const CONTROL = "src/components/phoenix-crm/speak.tsx";
const FORM = "src/components/phoenix-crm/visits-tab.tsx";

const BOTH: SpeakHalves = { text: true, audio: true };
const TEXT_ONLY: SpeakHalves = { text: true, audio: false };
const AUDIO_ONLY: SpeakHalves = { text: false, audio: true };
const NEITHER: SpeakHalves = { text: false, audio: false };

export function runPhoenixCrmSpeakTests() {
  // ── With neither half there is nothing to render ──────────────────────────────
  // An inert microphone reads as a bug, and the comment was never required to be spoken. On the server
  // both halves are false, which is what stops the control rendering on the first pass and vanishing.
  assert.equal(speakSupported(NEITHER), false, "no engine and no recorder renders nothing at all, rather than a button that does nothing");
  assert.equal(speakSupported(TEXT_ONLY), true, "one working half is still worth a button");
  assert.equal(speakSupported(AUDIO_ONLY), true);
  assert.equal(speakSupported(BOTH), true);
  assert.deepEqual(speakHalves(), NEITHER, "with no window there is neither engine nor recorder, so capability fails CLOSED");

  // ── The button promises exactly what this browser will do ─────────────────────
  // The failure this prevents: a rep on Firefox presses a button promising his words will be written,
  // speaks for forty seconds, and finds an empty comment — with the recording saved and no idea the
  // text half was never there.
  assert.match(speakPromise(BOTH), /written into the comment/, "with both halves he is told the words are written");
  assert.match(speakPromise(BOTH), /recording is kept/, "…and that the audio is kept — that is the whole of what he asked for");

  assert.match(speakPromise(AUDIO_ONLY), /recording is kept/, "the half that works is still promised");
  assert.match(
    speakPromise(AUDIO_ONLY),
    /cannot turn speech into text/,
    "a browser with no speech engine says so BEFORE he speaks — finding an empty comment afterwards is the failure this sentence exists for",
  );
  assert.doesNotMatch(
    speakPromise(AUDIO_ONLY).replace(/cannot turn speech into text/, ""),
    /written into the comment/,
    "it never promises the words will be written where nothing can write them",
  );

  assert.match(speakPromise(TEXT_ONLY), /written into the comment/);
  assert.match(speakPromise(TEXT_ONLY), /cannot keep a recording/, "and the mirror case says the audio will not be kept");
  assert.doesNotMatch(
    speakPromise(TEXT_ONLY).replace(/cannot keep a recording/, ""),
    /recording is kept/,
    "it never promises a recording where nothing records",
  );

  // ── Which of the two to believe when they disagree ────────────────────────────
  // The engine mishears, and a misheard brand name in a clinical note is a sale that never happened.
  // Said only where both halves ran, because with one half there is nothing to disagree with.
  const accuracy = speakAccuracyLine(BOTH);
  assert.ok(accuracy, "with both halves the rep is told which one is the record");
  assert.match(accuracy, /read it before you save/, "the text is his to correct — it is not evidence, it is a draft the engine wrote");
  assert.match(accuracy, /the recording is what you actually said/, "and the audio is named as the truth, because it cannot mishear him");
  assert.equal(speakAccuracyLine(TEXT_ONLY), null, "with no recording there are not two readings to choose between");
  assert.equal(speakAccuracyLine(AUDIO_ONLY), null);

  // ── The processor notice, on the control, naming the processors ───────────────
  // The owner's ruling of 2026-09-25: "add the processor line to the dictation mic, not the privacy
  // page". Recognition is not on the phone — Chrome streams the audio to Google and Safari to Apple —
  // and a visit comment carries the names of the AM and PM customers seen and what was said about
  // competitors. He ruled the processing acceptable AND ruled on where the rep is told.
  const notice = speakProcessorLine(BOTH);
  assert.ok(notice, "the control tells the rep his voice leaves the phone");
  for (const processor of ["Google", "Apple", "Chrome", "Safari"]) {
    assert.match(
      notice,
      new RegExp(processor),
      `the notice names ${processor} — "sent to a third party" tells the rep nothing he can act on, and naming the processor is the whole point of saying it`,
    );
  }
  assert.match(
    notice,
    /no speech service ever reads it/,
    "and it separates the two halves: the live stream is processed, the stored recording is not — saying only the first would read as though the file goes to Google too",
  );
  assert.match(speakProcessorLine(TEXT_ONLY) ?? "", /Google's on Chrome/, "the notice does not depend on the recorder being there");
  assert.doesNotMatch(
    speakProcessorLine(TEXT_ONLY) ?? "",
    /no speech service ever reads it/,
    "with no recording there is no stored file to exempt, and a sentence about one would be describing something that does not exist",
  );
  assert.equal(
    speakProcessorLine(AUDIO_ONLY),
    null,
    "recording alone sends the voice to nobody — Phoenix's own storage is not a speech service, and warning about one would be false",
  );

  // ── The live panel says what is happening to the voice right now ──────────────
  assert.equal(speakLiveLabel(BOTH, 7), `Listening — 0:07 of ${formatCap()}`, "the clock is shown because the recorder's cap is what ends the session");
  assert.equal(speakLiveLabel(AUDIO_ONLY, 7), `Recording — 0:07 of ${formatCap()}`, "with no words being written it is a recording, and says so");
  assert.equal(speakLiveLabel(TEXT_ONLY, 7), "Listening — speak now", "with no recorder there is no cap, so a countdown would be a clock to nothing");

  assert.match(speakLiveHint(BOTH), /Writing the words and keeping the recording/);
  assert.match(speakLiveHint(AUDIO_ONLY), /words are not being written/, "the missing half is named while he is still speaking, not after");
  assert.match(speakLiveHint(TEXT_ONLY), /Nothing is being recorded/);

  // ── Speaking again replaces the recording, and he is told so first ────────────
  // A visit holds ONE note, so a second stretch of speech appends to the text and replaces the audio.
  // That asymmetry is real; leaving him to find it means a visit whose recording is the last sentence
  // of a comment that has four.
  const again = speakAgainLine(BOTH);
  assert.ok(again);
  assert.match(again, /keeps the words you already have/, "nothing he has already said is thrown away");
  assert.match(again, /replaces the recording/, "and the half that IS replaced is named");
  assert.equal(speakAgainLine(TEXT_ONLY), null, "with no recorder there is no recording to replace");

  // ── A press that opened nothing, and a press that opened half ─────────────────
  assert.match(speakBlockedMessage(), /settings/, "a blocked microphone names where to unblock it — a rep cannot act on 'permission denied'");
  assert.match(speakBlockedMessage(), /type the comment instead/i, "and names typing as the way out: speaking was always an accelerator");

  assert.equal(speakPartialMessage(BOTH), null, "both halves running is not something to interrupt him about");
  assert.equal(speakPartialMessage(NEITHER), null, "nothing running at all is the blocked message's job, not this one");
  assert.match(
    String(speakPartialMessage(AUDIO_ONLY)),
    /words are not being written/,
    "the recorder opened and the engine did not — he must learn that now, not when he reads an empty comment",
  );
  assert.match(
    String(speakPartialMessage(TEXT_ONLY)),
    /recording did not start/,
    "the engine opened and the recorder did not — the words still land, and the missing recording is said out loud",
  );

  // ── The control renders the pinned sentences, and writes none of its own ──────
  // The point of the module above is defeated if the component hardcodes a second copy that drifts. So
  // every sentence is checked to be CALLED rather than spelled, and the component is checked not to
  // spell the notice itself. Comments are stripped first: the file's own header explains the rule and
  // necessarily quotes it, and a check over raw source would pass on the documentation of a screen
  // that has stopped saying anything — measured on the dictation notice on 2026-09-25.
  const control = stripComments(readFileSync(CONTROL, "utf8"));
  for (const call of ["speakPromise(halves)", "speakAccuracyLine(halves)", "speakProcessorLine(halves)", "speakBlockedMessage()"]) {
    assert.ok(control.includes(call), `${CONTROL} renders ${call} rather than a second copy of that sentence`);
  }
  assert.doesNotMatch(
    control,
    /Your voice is sent to|what you actually said|cannot turn speech into text/,
    `${CONTROL} spells none of the wording itself — one copy, in src/lib/phoenix-crm/speak.ts, where the tests above can reach it`,
  );

  // The live panel reads the halves that STARTED, never the halves the browser merely has. A phone can
  // refuse the recorder alone, and a panel reading capability would then count down a recording that
  // is not running.
  assert.match(control, /speakLiveLabel\(started, elapsed\)/, `${CONTROL} clocks what actually started`);
  assert.match(control, /speakLiveHint\(started\)/, `${CONTROL} describes what actually started`);
  assert.match(control, /speakPartialMessage\(started\)/, `${CONTROL} reports a half that did not open`);

  // ── The microphone is opened once and handed back on every exit ───────────────
  // A live track is a microphone the phone still considers in use, and the OS says so in the status bar
  // long after the form thinks it has finished. Both halves hold one, so both are released together.
  assert.match(control, /dictation\.current\?\.stop\(\)/, `${CONTROL} hands back the speech engine`);
  assert.match(control, /recorder\.current\?\.cancel\(\)/, `${CONTROL} hands back the recorder`);
  assert.match(
    control,
    /useEffect\(\(\) => release, \[release\]\)/,
    `${CONTROL} releases on unmount — Cancel, a saved visit and the tab closing all leave this screen`,
  );

  // Pressing Save CANCELS both halves; it never stops-and-uploads. `stop` would store whatever was
  // caught so far, and half a sentence filed against a visit is worse than no recording at all — a
  // reviewer cannot tell a truncated note from a complete one.
  assert.match(
    control,
    /const abort = useCallback\(\(\) => \{\s*release\(\);/,
    `${CONTROL} throws the part-recording away on Save rather than uploading it`,
  );
  assert.doesNotMatch(control, /if \(disabled\)[^\n]*stopRef/, `${CONTROL} never routes Save through the path that uploads`);

  // And the panel is hidden in the SAME render Save was pressed, rather than a tick later when the
  // cancel lands — a microphone drawn as open on a form that has stopped listening is a lie on screen.
  assert.match(control, /const open = listening && !disabled;/, `${CONTROL} derives the open panel from the form's own saving state`);

  // The recorder is awaited BEFORE the engine starts. One prompt, answered once, and the engine then
  // opens its capture against a microphone already allowed.
  const recorderAt = control.indexOf("await startRecording(");
  const speechAt = control.indexOf("startDictation({");
  assert.ok(recorderAt > 0 && speechAt > 0, `${CONTROL} starts both halves`);
  assert.ok(recorderAt < speechAt, `${CONTROL} opens the recorder first, so the rep answers one permission prompt rather than two`);

  // The cap ends the WHOLE session, not just the tape. Otherwise the recorder stops itself at a minute
  // and the engine keeps writing, so the comment holds sentences the recording does not — which is the
  // one mismatch a rep would never think to check.
  assert.match(
    control,
    /if \(seconds >= MAX_SECONDS\) stopRef\.current\(\)/,
    `${CONTROL} stops both halves at the cap — words written past the end of the tape are a comment the recording cannot back`,
  );

  // ── One button, mounted once, with both jobs wired to it ──────────────────────
  const form = stripComments(readFileSync(FORM, "utf8"));
  assert.equal([...form.matchAll(/<CrmSpeak\b/g)].length, 1, `${FORM} has exactly one spoken-comment control — the owner asked for one option`);
  assert.match(form, /onAppend=\{\(spoken\) => setComment/, `${FORM} takes the words into the comment field`);
  assert.match(form, /onChange=\{setVoiceNote\}/, `${FORM} takes the recording into the visit's payload`);
  assert.doesNotMatch(
    form,
    /phoenix-crm\/dictate"|phoenix-crm\/voice-note"/,
    `${FORM} imports neither replaced control — a stale import is how a deleted button comes back`,
  );

  // The cap is applied by the caller, not by the textarea: `maxLength` constrains TYPING and does
  // nothing to a programmatic append, so a long spoken comment would push the field past the limit and
  // the server would refuse the save with nothing on screen saying why.
  assert.match(form, /appendDictated\(current, spoken, VISIT_COMMENT_MAX\)/, `${FORM} clamps the spoken text to the cap the server checks`);

  // ── The two labels ────────────────────────────────────────────────────────────
  assert.equal(SPEAK_LABEL, "Speak the comment", "the button says what it does, for a rep who has never used either half");
  assert.equal(SPEAK_AGAIN_LABEL, "Speak again");
}

/** The recorder's cap as the clock shows it, so this file does not hardcode a minute beside the module. */
function formatCap(): string {
  const minutes = Math.floor(MAX_SECONDS / 60);
  return `${minutes}:${String(MAX_SECONDS % 60).padStart(2, "0")}`;
}

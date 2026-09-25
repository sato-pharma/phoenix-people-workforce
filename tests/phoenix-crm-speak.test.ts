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
  speakTextEngine,
  speakTranscribingLine,
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
// words into the comment, and the audio kept with the visit.
//
// THE TEXT HALF HAS TWO ENGINES, and telling them apart is most of what this file does. The same day the
// owner said "un browsers must be text and audio", because Firefox has no speech engine at all — no
// constructor to call, on any platform, and Firefox 157's new on-device engine has no Arabic either. So:
//
//   "live"   — the browser's own engine (Chrome, Edge, Safari, Android) writes words AS HE TALKS. The
//              text is a SECOND, PARALLEL reading of the speech, and no speech service reads the stored
//              file. Calling the text "the transcript of the note" is FALSE here.
//   "server" — no engine at all, so the finished RECORDING is sent to Phoenix and the words come back
//              AFTER HE STOPS. Here the text IS a transcript of the recording, which is the exact
//              opposite, and the notice has to admit that the stored file is what leaves the phone.
//   "none"   — nothing can produce text.
//
// WHAT THIS FILE EXISTS TO STOP, in three parts:
//
//   1. THE WORDING IS PURE AND PINNED. Every sentence the rep reads comes from a function here rather
//      than from JSX, so a later tidy-up of the component cannot quietly change what he was promised.
//   2. IT PROMISES ONLY WHAT THE BROWSER HAS, AND ONLY WHEN IT HAPPENS. A button promising "both" where
//      one half works is copy a rep discovers at a clinic door; so is one promising words "as you talk"
//      on a browser that writes them a few seconds after Stop — he watches an empty field for a minute
//      and presses Stop thinking it failed.
//   3. THE PROCESSOR NOTICE STAYS ON THE CONTROL and names the processor, on the owner's ruling the same
//      day — "add the processor line to the dictation mic, not the privacy page". The two engines send
//      DIFFERENT THINGS, so the live branch exempts the stored recording by name and the server branch
//      must not: there, the recording is precisely what is sent.
//
// The recording's own rules (its path, its clamped figures, that nothing dates it, that the audio's own
// path meets no recogniser) are pinned in phoenix-crm-voice-note.test.ts, which reads this same control.
// ─────────────────────────────────────────────────────────────────────────────

const CONTROL = "src/components/phoenix-crm/speak.tsx";
const FORM = "src/components/phoenix-crm/visits-tab.tsx";

const BOTH: SpeakHalves = { text: "live", audio: true };
const TEXT_ONLY: SpeakHalves = { text: "live", audio: false };
const SERVER: SpeakHalves = { text: "server", audio: true };
const AUDIO_ONLY: SpeakHalves = { text: "none", audio: true };
const NEITHER: SpeakHalves = { text: "none", audio: false };

export function runPhoenixCrmSpeakTests() {
  // ── With neither half there is nothing to render ──────────────────────────────
  // An inert microphone reads as a bug, and the comment was never required to be spoken. On the server
  // both halves are false, which is what stops the control rendering on the first pass and vanishing.
  assert.equal(speakSupported(NEITHER), false, "no engine and no recorder renders nothing at all, rather than a button that does nothing");
  assert.equal(speakSupported(TEXT_ONLY), true, "one working half is still worth a button");
  assert.equal(speakSupported(AUDIO_ONLY), true);
  assert.equal(speakSupported(SERVER), true);
  assert.equal(speakSupported(BOTH), true);
  assert.deepEqual(speakHalves(true), NEITHER, "with no window there is neither engine nor recorder, so capability fails CLOSED even where the server path is configured");

  // ── Which engine writes the words, every combination ──────────────────────────
  // Pinned on the pure function because the browser capabilities the live one reads cannot be faked here.
  // Two rules carry it. The browser's OWN engine always wins where it exists — free, no account, and it
  // writes while he talks. And the server engine needs the RECORDER, because what it transcribes IS the
  // recording: offered without one, it promises a transcript of a file that will never exist.
  for (const serverTranscription of [true, false]) {
    for (const audio of [true, false]) {
      assert.equal(
        speakTextEngine({ audio, live: true, serverTranscription }),
        "live",
        "a browser with its own engine always uses it — it is free, needs no account, and writes as he talks",
      );
    }
  }
  assert.equal(
    speakTextEngine({ audio: true, live: false, serverTranscription: true }),
    "server",
    "no engine, a recorder, and the path configured: Firefox, which is the whole reason the second engine exists",
  );
  assert.equal(
    speakTextEngine({ audio: false, live: false, serverTranscription: true }),
    "none",
    "no recorder means no file to transcribe, so the words are not offered — a transcript of nothing is the one promise that cannot be kept",
  );
  assert.equal(
    speakTextEngine({ audio: true, live: false, serverTranscription: false }),
    "none",
    "and with the server path unconfigured the button stops promising words, rather than promising them and failing after every recording",
  );
  assert.equal(speakTextEngine({ audio: false, live: false, serverTranscription: false }), "none");

  // ── The button promises exactly what this browser will do ─────────────────────
  // The failure this prevents: a rep on Firefox presses a button promising his words will be written,
  // speaks for forty seconds, and finds an empty comment — with the recording saved and no idea the
  // text half was never there.
  assert.match(speakPromise(BOTH), /written into the comment/, "with both halves he is told the words are written");
  assert.match(speakPromise(BOTH), /recording is kept/, "…and that the audio is kept — that is the whole of what he asked for");
  assert.match(speakPromise(BOTH), /as you talk/, "the live engine writes while he speaks, and says so");

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

  // The server engine's promise is the one that has to name WHEN, not just whether.
  const serverPromise = speakPromise(SERVER);
  assert.match(serverPromise, /recording is kept/, "the audio half is the same on every browser");
  assert.match(serverPromise, /written into the comment when you stop/, "the words are promised for when they actually arrive — after Stop, not while he talks");
  assert.match(serverPromise, /cannot write them as you talk/, "and the thing this browser cannot do is said out loud, because the live case is what a rep will have seen on another phone");
  assert.doesNotMatch(
    serverPromise.replace(/cannot write them as you talk/, ""),
    /as you talk/,
    "it never promises live words on a browser that has no engine — he would watch an empty field for a minute and press Stop thinking it failed",
  );

  // ── Which of the two to believe when they disagree ────────────────────────────
  // Either engine mishears, and a misheard brand name in a clinical note is a sale that never happened.
  // Said only where both halves ran, because with one half there is nothing to disagree with.
  const accuracy = speakAccuracyLine(BOTH);
  assert.ok(accuracy, "with both halves the rep is told which one is the record");
  assert.match(accuracy, /read it before you save/, "the text is his to correct — it is not evidence, it is a draft the engine wrote");
  assert.match(accuracy, /the recording is what you actually said/, "and the audio is named as the truth, because it cannot mishear him");
  assert.equal(speakAccuracyLine(TEXT_ONLY), null, "with no recording there are not two readings to choose between");
  assert.equal(speakAccuracyLine(AUDIO_ONLY), null);

  // The server engine gets the same ruling with the true description of where the text came from: it is
  // the service's reading OF the recording, not a second live reading of the same speech.
  const serverAccuracy = speakAccuracyLine(SERVER);
  assert.ok(serverAccuracy);
  assert.match(serverAccuracy, /made of the recording/, "here the text IS a reading of the file, and the sentence says so rather than borrowing the live engine's wording");
  assert.match(serverAccuracy, /read it before you save/, "…and it is still a draft he checks");
  assert.match(serverAccuracy, /the recording is what you actually said/);

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

  // THE ONE ASSERTION THAT CANNOT BE RELAXED. On the server engine the RECORDING ITSELF is what leaves
  // the phone. Reusing the live engine's exemption here would be a flat lie about the single fact this
  // notice exists to be honest about, and it is the copy-paste a later edit is most likely to make.
  const serverNotice = speakProcessorLine(SERVER);
  assert.ok(serverNotice, "a browser with no engine of its own still tells the rep where his voice goes");
  assert.match(serverNotice, /Groq/, "and names the processor, the same as the live branch does");
  assert.match(serverNotice, /sends the recording/, "it says the RECORDING is what is sent — that is what happens here, and it is different from the live engine");
  assert.doesNotMatch(
    serverNotice,
    /no speech service ever reads it/,
    "it must NEVER claim the stored file is read by nothing: on this engine the stored file is exactly what is read, and that sentence is the live branch's, not this one's",
  );
  assert.doesNotMatch(serverNotice, /Google|Apple/, "and it does not name the browser engines that this browser does not have");

  // ── The live panel says what is happening to the voice right now ──────────────
  assert.equal(speakLiveLabel(BOTH, 7), `Listening — 0:07 of ${formatCap()}`, "the clock is shown because the recorder's cap is what ends the session");
  assert.equal(speakLiveLabel(AUDIO_ONLY, 7), `Recording — 0:07 of ${formatCap()}`, "with no words being written it is a recording, and says so");
  assert.equal(
    speakLiveLabel(SERVER, 7),
    `Recording — 0:07 of ${formatCap()}`,
    "the server engine is not listening to anything yet — nothing is being recognised while he speaks, so calling it Listening would describe a process that is not running",
  );
  assert.equal(speakLiveLabel(TEXT_ONLY, 7), "Listening — speak now", "with no recorder there is no cap, so a countdown would be a clock to nothing");

  assert.match(speakLiveHint(BOTH), /Writing the words and keeping the recording/);
  assert.match(speakLiveHint(AUDIO_ONLY), /words are not being written/, "the missing half is named while he is still speaking, not after");
  assert.match(speakLiveHint(TEXT_ONLY), /Nothing is being recorded/);
  assert.match(
    speakLiveHint(SERVER),
    /words are written when you stop/,
    "and the server engine promises them for when they come, so an empty comment mid-sentence is expected rather than alarming",
  );

  // The wait after Stop is its own state and says not to leave yet: the words arrive a few seconds later,
  // and a rep who saves the visit in that gap keeps the recording and loses the text.
  assert.match(speakTranscribingLine(), /few seconds/, "the wait is given a length, so it does not read as a hang");
  assert.match(speakTranscribingLine(), /Do not leave the visit yet/, "and it says what would cost him the words");

  // ── Speaking again replaces the recording, and he is told so first ────────────
  // A visit holds ONE note, so a second stretch of speech appends to the text and replaces the audio.
  // That asymmetry is real; leaving him to find it means a visit whose recording is the last sentence
  // of a comment that has four.
  const again = speakAgainLine(BOTH);
  assert.ok(again);
  assert.match(again, /keeps the words you already have/, "nothing he has already said is thrown away");
  assert.match(again, /replaces the recording/, "and the half that IS replaced is named");
  assert.ok(speakAgainLine(SERVER), "true on every browser that records, whichever engine writes the words");
  assert.equal(speakAgainLine(TEXT_ONLY), null, "with no recorder there is no recording to replace");

  // ── A press that opened nothing, and a press that opened half ─────────────────
  assert.match(speakBlockedMessage(), /settings/, "a blocked microphone names where to unblock it — a rep cannot act on 'permission denied'");
  assert.match(speakBlockedMessage(), /type the comment instead/i, "and names typing as the way out: speaking was always an accelerator");

  assert.equal(speakPartialMessage(BOTH), null, "both halves running is not something to interrupt him about");
  assert.equal(speakPartialMessage(NEITHER), null, "nothing running at all is the blocked message's job, not this one");
  assert.equal(
    speakPartialMessage(SERVER),
    null,
    "the server engine cannot 'fail to start' — it runs on the finished file — so a recorder running on that browser is everything that was ever going to run",
  );
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
  for (const call of [
    "speakPromise(halves)",
    "speakAccuracyLine(halves)",
    "speakProcessorLine(halves)",
    "speakBlockedMessage()",
    "speakTranscribingLine()",
  ]) {
    assert.ok(control.includes(call), `${CONTROL} renders ${call} rather than a second copy of that sentence`);
  }
  assert.doesNotMatch(
    control,
    /Your voice is sent to|what you actually said|cannot turn speech into text|sends the recording to/,
    `${CONTROL} spells none of the wording itself — one copy, in src/lib/phoenix-crm/speak.ts, where the tests above can reach it`,
  );

  // The live panel reads the halves that STARTED, never the halves the browser merely has. A phone can
  // refuse the recorder alone, and a panel reading capability would then count down a recording that
  // is not running.
  assert.match(control, /speakLiveLabel\(started, elapsed\)/, `${CONTROL} clocks what actually started`);
  assert.match(control, /speakLiveHint\(started\)/, `${CONTROL} describes what actually started`);
  assert.match(control, /speakPartialMessage\(started\)/, `${CONTROL} reports a half that did not open`);

  // ── The engine is chosen once, and the live one is the only one started here ───
  // `startDictation` returns null on a browser with no engine, so a control that called it on every
  // browser would look correct and do nothing. It is gated on the engine by name instead, which is also
  // what keeps the server path out of the microphone-open code entirely — it runs on the finished file.
  assert.match(control, /if \(engine === "live"\)/, `${CONTROL} starts the browser engine only where there IS one`);
  assert.match(
    control,
    /engine === "server" && tape \? "server"/,
    `${CONTROL} counts the server engine as the text half only where a recorder is actually running to produce the file it needs`,
  );

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

  // ── The words are asked for AFTER the recording is safely stored ───────────────
  // The ordering is the design, not an accident of where the call sits: the upload and the transcription
  // are two separate blocks, and the second is skipped entirely when the first did not land. A speech
  // service that refuses then costs the rep the typing he would have done anyway — never his recording.
  const storedAt = control.indexOf("stored = slot.path");
  const transcribeAt = control.indexOf("TRANSCRIBE_URL, { path: stored }");
  assert.ok(storedAt > 0, `${CONTROL} records that the upload landed`);
  assert.ok(transcribeAt > storedAt, `${CONTROL} asks for the words only after the recording is stored`);
  assert.match(
    control,
    /if \(!stored \|\| engine !== "server"\) return;/,
    `${CONTROL} sends nothing to a speech service when the upload failed, and nothing at all on a browser with its own engine`,
  );
  assert.match(
    control,
    /\{ path: stored \}/,
    `${CONTROL} transcribes by PATH — re-uploading two megabytes of audio a second time on a clinic's 3G is the whole reason this is not a multipart POST`,
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
  // the server would refuse the save with nothing on screen saying why. It has to hold for BOTH engines:
  // the server engine hands back a whole minute of speech in one append, which is the longest single
  // write this field ever takes.
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

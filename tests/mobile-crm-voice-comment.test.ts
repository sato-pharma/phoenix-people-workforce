import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { appendCrmDictated } from "../mobile/src/lib/crm/dictation.ts";
import { appendDictated } from "../src/lib/phoenix-crm/dictation.ts";

const VOICE = new URL("../mobile/src/lib/crm/voice.ts", import.meta.url);
const CONTROL = new URL("../mobile/src/components/crm/speak-comment.tsx", import.meta.url);
const SCREEN = new URL("../mobile/src/features/crm/visits-screen.tsx", import.meta.url);
const APP_JSON = new URL("../mobile/app.json", import.meta.url);

/**
 * Phoenix CRM — the spoken visit comment on the phone.
 *
 * The owner's instruction of 2026-09-25: the microphone must do both halves on the app as it does on the
 * web — keep the recording AND write what was said into the comment as Arabic text. The app has no speech
 * engine of its own (no Web Speech API, no free on-device Arabic recogniser), so it takes the web's
 * Firefox path: upload the finished recording, then ask Phoenix's server to write it out. That shape has
 * three ways to break silently, none of which any screen would show, so each is pinned here:
 *
 *   - the words are made to arrive "as you talk", which the app cannot do — a rep told so watches an empty
 *     box for a minute and presses Stop believing it failed, the exact report that started this feature;
 *   - the recording is uploaded but left out of the visit payload, orphaning the audio in the bucket while
 *     the rep believes it is attached;
 *   - the append that adds spoken words to typed ones drifts from the web's, so the two clients treat the
 *     cap or a half-typed comment differently.
 *
 * A root test reads the mobile source as text because the app is a separate bundle with its own tsconfig
 * that the root suite cannot compile — the same idiom as tests/mobile-push-link.test.ts.
 */
export async function runMobileCrmVoiceCommentTests() {
  const voice = readFileSync(VOICE, "utf8");
  const control = readFileSync(CONTROL, "utf8");
  const screen = readFileSync(SCREEN, "utf8");
  const appJson = JSON.parse(readFileSync(APP_JSON, "utf8")) as {
    expo: { android: { permissions: string[] }; plugins: unknown[] };
  };

  // --- The append matches the web's, output for output. ------------------------------------------
  // A spoken sentence is added to whatever the rep already typed, never over it, and at the cap the
  // SPOKEN half is trimmed at a word while every typed character survives. Both functions are run over
  // the same cases so the two bundles can never disagree about what "append" means.
  const cases: Array<[existing: string, spoken: string, max: number, why: string]> = [
    ["", "زيارة اليوم", 1000, "into an empty box"],
    ["كتب للأطفال", "وقال هيزيدها", 1000, "after what he typed"],
    ["كتب للأطفال ", "  وقال   هيزيدها  ", 1000, "whitespace on both sides collapses"],
    ["", "", 1000, "nothing spoken changes nothing"],
    ["اللي اتكتب", "", 1000, "silence keeps the typed text"],
    ["", "كلمة ".repeat(50).trim(), 40, "a long dictation is cut at a word boundary"],
    ["حرف ".repeat(20).trim(), "زيادة كتيرة قوي", 60, "no room left keeps the typed text unchanged"],
  ];
  for (const [existing, spoken, max, why] of cases) {
    assert.equal(
      appendCrmDictated(existing, spoken, max),
      appendDictated(existing, spoken, max),
      `the app's append must match the web's — ${why}`,
    );
  }
  // And it never lengthens past the cap or drops what was typed.
  const capped = appendCrmDictated("محفوظ", "زيادة ".repeat(400).trim(), 50);
  assert.ok(capped.length <= 50, "the append never runs past the cap");
  assert.ok(capped.startsWith("محفوظ"), "the append never drops a character the rep typed");

  // --- It writes AFTER stop, and the copy must never promise otherwise. --------------------------
  // A live-preview promise is the one wording that breaks this feature by working exactly as described
  // right up until the words do not appear. These labels are forbidden in the control's COPY — the text a
  // rep reads — so the comments are stripped first: the header itself forbids a "listening" label and a
  // "live preview" in prose, and that instruction must not read as the very thing it bans.
  const copy = control.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const forbidden of [/as you (talk|speak)/i, /while you (talk|speak)/i, /listening/i, /\blive\b/i, /real[- ]?time/i]) {
    assert.doesNotMatch(copy, forbidden, `the app cannot write speech as it is spoken, so the copy must not say it does (${forbidden})`);
  }
  assert.match(control, /written when you stop|after you stop|when you stop/i, "the copy says the words come after Stop");
  assert.match(
    control,
    /IT WRITES AFTER STOP/,
    "the load-bearing reason for the copy stays in the file so the next editor does not add a live preview",
  );

  // --- The recording is stored first and transcribed second. -------------------------------------
  // A speech service that refuses must cost the rep only the typing he would have done anyway, never the
  // words he already said. So the upload comes before the transcribe, and a refused transcribe returns
  // the STORED note with empty text rather than a failure.
  // The CALL sites, not any mention — the header names both routes in prose before either is called.
  const uploadAt = voice.indexOf('crmPost<VoiceSlot>("/api/phoenix-crm/voice/upload-slot"');
  const transcribeAt = voice.indexOf('crmPost<string>("/api/phoenix-crm/voice/transcribe"');
  assert.ok(uploadAt > 0 && transcribeAt > 0, "both routes are called from the phone");
  assert.ok(uploadAt < transcribeAt, "the recording is stored before it is transcribed, so a failed transcription never loses the audio");
  assert.match(
    voice,
    /return \{ note, status: "stored", text: "" \}/,
    "a refused transcription returns the stored note with empty text, not a failure",
  );

  // --- The availability probe is the free GET, never the paid POST. ------------------------------
  assert.match(
    voice,
    /crmGet<\{ available: boolean \}>\("\/api\/phoenix-crm\/voice\/transcribe", "transcription"/,
    "whether speech can be written out is asked with the free GET, not the POST that spends money to find out",
  );

  // --- The visit payload carries the recording, exactly as the web's does. -----------------------
  // Without these three fields the uploaded recording is an orphan: bytes in the bucket, a slot never
  // consumed, and audio the rep believes he attached attached to nothing.
  for (const field of [/voiceNotePath: voiceNote\?\.path \?\? null/, /voiceNoteSeconds: voiceNote\?\.seconds \?\? null/, /voiceNoteBytes: voiceNote\?\.bytes \?\? null/]) {
    assert.match(screen, field, `the mobile visit save must carry the voice note (${field})`);
  }
  assert.match(screen, /appendCrmDictated\(current, spoken, VISIT_COMMENT_MAX\)/, "the spoken words are appended to the comment at the comment's own cap");
  assert.match(screen, /<CrmSpeakComment/, "the microphone control is mounted on the visit form");

  // --- The permission the recording needs is declared, and image-picker no longer blocks it. -----
  // expo-image-picker with microphonePermission:false calls withBlockedPermissions(['RECORD_AUDIO']),
  // which strips the permission whatever else adds it, so a false here ships a recorder that cannot open.
  assert.ok(
    appJson.expo.android.permissions.includes("android.permission.RECORD_AUDIO"),
    "the app declares the microphone permission the recorder needs",
  );
  const imagePicker = appJson.expo.plugins.find(
    (plugin): plugin is [string, { microphonePermission?: unknown }] => Array.isArray(plugin) && plugin[0] === "expo-image-picker",
  );
  if (imagePicker) {
    assert.notEqual(
      imagePicker[1]?.microphonePermission,
      false,
      "image-picker must not set microphonePermission:false — it strips RECORD_AUDIO and disables the recorder",
    );
  }
}

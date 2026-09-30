import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendDictated,
  dictationErrorMessage,
  DICTATION_LANG,
  isDictationSupported,
  isEngineLanguageError,
  isSilentRecognitionError,
} from "../src/lib/phoenix-crm/dictation.ts";
import { VISIT_COMMENT_MAX } from "../src/lib/phoenix-crm/entry-rules.ts";

export function runPhoenixCrmDictationTests() {
  // ── The engine is asked for Egyptian Arabic, not Modern Standard ──────────────────────────────
  assert.equal(DICTATION_LANG, "ar-EG", "the field force speaks Egyptian Arabic; ar-SA or ar would transcribe it badly");

  // ── Absent, never broken ──────────────────────────────────────────────────────────────────────
  assert.equal(
    isDictationSupported(),
    false,
    "with no window there is no speech engine, so support fails CLOSED and the control renders nothing rather than an inert microphone",
  );

  // ── Append, never replace ─────────────────────────────────────────────────────────────────────
  assert.equal(
    appendDictated("", "زرت الدكتور أحمد", VISIT_COMMENT_MAX),
    "زرت الدكتور أحمد",
    "the first phrase into an empty comment is the comment, with no leading space",
  );
  assert.equal(
    appendDictated("Typed the first half.", "وقلت له على المنتج", VISIT_COMMENT_MAX),
    "Typed the first half. وقلت له على المنتج",
    "a rep who typed half a sentence and then spoke the rest keeps BOTH halves — dictation never replaces what is there",
  );
  assert.equal(
    appendDictated("first", "second", VISIT_COMMENT_MAX),
    "first second",
    "consecutive phrases are joined by exactly one space",
  );
  assert.equal(
    appendDictated("first   ", "second", VISIT_COMMENT_MAX),
    "first second",
    "trailing whitespace in the comment never becomes a double space when a phrase lands after it",
  );
  assert.equal(
    appendDictated("first", "  second   phrase  ", VISIT_COMMENT_MAX),
    "first second phrase",
    "the recogniser's own padding is collapsed, so a comment is not peppered with runs of spaces",
  );

  // ── A phrase that says nothing changes nothing ────────────────────────────────────────────────
  assert.equal(appendDictated("kept", "", VISIT_COMMENT_MAX), "kept", "an empty phrase leaves the comment untouched");
  assert.equal(appendDictated("kept", "   ", VISIT_COMMENT_MAX), "kept", "a whitespace-only phrase leaves the comment untouched");

  // ── The cap, which maxLength on the textarea does NOT enforce for a programmatic append ───────
  // This is the whole reason the cap lives in this function: `maxLength` constrains typing only, so
  // without it a long dictation pushes the field past VISIT_COMMENT_MAX and the SERVER refuses the
  // save with "The comment is longer than 1000 characters." — with nothing on screen saying why.
  assert.equal(
    appendDictated("abc", "defgh ijkl", 12),
    "abc defgh",
    "a phrase that does not fit whole is cut at a word boundary inside the room left, never mid-word",
  );
  assert.ok(appendDictated("abc", "defgh ijkl", 12).length <= 12, "the clamped result never exceeds the cap");
  assert.equal(
    appendDictated("ab", "cd", 5),
    "ab cd",
    "a phrase that fits EXACTLY to the cap is kept whole — the boundary is inclusive",
  );
  assert.equal(
    appendDictated("abcdefghij", "more", 10),
    "abcdefghij",
    "a comment already at the cap is returned unchanged rather than truncated, so speaking into a full comment destroys nothing",
  );
  assert.equal(
    appendDictated("", "abcdefghij", 4),
    "abcd",
    "one word longer than the whole budget has no boundary to cut at, so it is cut where it must be",
  );

  const long = appendDictated("x".repeat(VISIT_COMMENT_MAX - 5), "one two three four five", VISIT_COMMENT_MAX);
  assert.ok(
    long.length <= VISIT_COMMENT_MAX,
    "against the real VISIT_COMMENT_MAX the append still lands inside the cap the server checks",
  );

  // ── Which recogniser errors are worth a message ───────────────────────────────────────────────
  assert.equal(isSilentRecognitionError("aborted"), true, "the rep pressed Stop — telling him it failed teaches him the feature is broken");
  assert.equal(isSilentRecognitionError("no-speech"), true, "the rep said nothing, which is not a failure");
  assert.equal(isSilentRecognitionError("not-allowed"), false, "a blocked microphone is the ONE error the rep must be told about");
  assert.equal(isSilentRecognitionError("network"), false, "an unknown error is shown rather than swallowed");

  // ── The engine that EXISTS and cannot do Arabic ────────────────────────────────────────────────
  // Firefox 157 ships a recogniser backed by NVIDIA's Parakeet, whose language list has no Arabic. It
  // constructs, it accepts `ar-EG`, `start()` SUCCEEDS, and only then does this code arrive — so no
  // capability check taken before the rep speaks can see it. The owner met this within the hour of the
  // first ship ("DIDNT WROITE", 2026-09-25): his words were recorded and his comment stayed empty.
  //
  // It is kept apart from the silent set and from the messages because the caller ACTS on it: the
  // recording is written out by the server instead, and the rep is told nothing at all.
  assert.equal(isEngineLanguageError("language-not-supported"), true, "the one code that means this browser's own engine is out for Arabic");
  assert.equal(isEngineLanguageError("not-allowed"), false, "a blocked microphone is not an engine that lacks the language — it is the rep's to fix, and no handover would help");
  assert.equal(isEngineLanguageError("network"), false);
  assert.equal(
    isSilentRecognitionError("language-not-supported"),
    false,
    "it is NOT silent: where the recording cannot be written out the rep must still be told his words are not coming",
  );

  // And the sentence is the NO-HANDOVER one. Where the recording can be written out the caller shows
  // nothing and lets "Writing out the words" speak for itself, so these words only ever reach a rep when
  // nothing else is coming — which is exactly when promising him words from the recording would be a lie.
  const languageMessage = dictationErrorMessage("language-not-supported");
  assert.match(languageMessage, /cannot write Arabic while you talk/, "it names what this browser cannot do, rather than reading as a failure he caused");
  assert.match(languageMessage, /type the comment instead/i, "and names the way out, because on this path nothing else will fill the comment");
  assert.match(languageMessage, /recording is still saved/, "while saying the half that DID work is safe — the recording is what he actually said");

  assert.match(
    dictationErrorMessage("not-allowed"),
    /settings/,
    "a blocked microphone names where to unblock it, because the rep cannot act on 'permission denied'",
  );
  assert.match(dictationErrorMessage("service-not-allowed"), /settings/, "the engine's other permission code reads the same to the rep");
  assert.match(dictationErrorMessage("audio-capture"), /microphone was found/, "no microphone on the handset is its own cause, not a permission problem");
  for (const code of ["not-allowed", "service-not-allowed", "audio-capture", "network", "anything-else"]) {
    assert.match(
      dictationErrorMessage(code),
      /type the comment instead/i,
      `every dictation failure names typing as the way out (${code}) — dictation is an accelerator and the comment can always be typed`,
    );
  }

  // ── The rep is NOT told on the form, since 2026-09-30 ───────────────────────────────────────────
  // Recognition is not on the phone: Chrome streams the audio to Google and Safari to Apple. The owner
  // ruled that processing acceptable. On 2026-09-25 he put a processor line under the microphone; on
  // 2026-09-30 he had it removed with the rest of the text under the Speak button ("remove this
  // irrelevant text"). The removal itself is pinned in tests/phoenix-crm-speak.test.ts; what is pinned
  // here is the decision, in this module's header — the place the next session reading about dictation
  // hits first, so nobody "restores" the line to the form or to app/privacy on their own.
  const dictation = readFileSync("src/lib/phoenix-crm/dictation.ts", "utf8");
  assert.match(
    dictation,
    /Whether the REP is told on the form: NO, since 2026-09-30/,
    "the module header records the owner's latest ruling — a header still describing the 2026-09-25 notice would send the next session to put it back",
  );
  assert.doesNotMatch(
    dictation,
    /the owner's call, and it is still open/,
    "the sentence that called it open is gone, not just contradicted further down",
  );

  // The engine's own code reaches the caller, not only the rep-facing sentence. Handing back the message
  // alone forced the component to match on English prose to find the handover case, which is how a
  // reworded sentence becomes a silent regression in the one path the owner already caught once.
  assert.match(
    dictation,
    /callbacks\.onError\(dictationErrorMessage\(event\.error\), event\.error\)/,
    "startDictation passes the engine's code beside the sentence, so the caller branches on the code",
  );
  assert.match(
    dictation,
    /onError: \(message: string, code: string\) => void/,
    "…and the callback's type says so, rather than leaving the second argument undocumented",
  );
}

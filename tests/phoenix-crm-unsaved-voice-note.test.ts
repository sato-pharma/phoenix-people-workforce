import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  shouldWarnUnsavedVoiceNote,
  UNSAVED_VOICE_NOTE_LEAVE_LABEL,
  UNSAVED_VOICE_NOTE_STAY_LABEL,
  UNSAVED_VOICE_NOTE_WARNING,
} from "../src/lib/phoenix-crm/unsaved-voice-note.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — leaving the visit form with a recording that was never saved.
 *
 * Measured, not imagined: on 25 September a rep recorded NINE voice notes across a full working day,
 * every one of them reaching the bucket, and not one was ever attached to a saved visit. He took no
 * photo either, so no visit was recorded at all. Record, record, record, never save is what a person
 * does when they believe the recording IS the log — and nothing on the form said otherwise at the
 * moment it mattered.
 *
 * The owner's instruction, 2026-09-28: warn a rep who leaves a recorded voice note unsaved.
 *
 * THE THREE THINGS PINNED HERE, each because getting it wrong is worse than the defect:
 *
 *   1. IT NEVER REFUSES. The second press leaves, every time. A guard a rep cannot get out of is a
 *      trap, and a trap on the visit form is how a rep learns to dread the one screen he must use
 *      every day. This is the single most likely way a well-meant warning becomes the opposite of
 *      Golden Rule #1, so it is the first assertion in the file.
 *
 *   2. IT NEVER INTERRUPTS A SAVE. If a save is in flight the form is already closing itself.
 *
 *   3. IT SAYS WHAT HE LOSES, NOT WHAT HE DID WRONG. No "you forgot", no "unsaved changes", no
 *      "warning", no "error" — the thing he is missing is a fact about the app, not a failing of his.
 *
 * The wiring is pinned too: both exits on both platforms must go through the one guard. Before this
 * change the phone's back arrow and its Cancel button each called `onClose` directly, which is
 * exactly how a rule ends up applying to one of them and not the other.
 */

function read(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export async function runPhoenixCrmUnsavedVoiceNoteTests(): Promise<void> {
  // ── 1. It warns once, and then it lets him go ────────────────────────────────────────────────
  {
    assert.equal(
      shouldWarnUnsavedVoiceNote({ hasVoiceNote: true, saving: false, warned: false }),
      true,
      "a recording on the form and a first press to leave — he is told what it costs",
    );
    assert.equal(
      shouldWarnUnsavedVoiceNote({ hasVoiceNote: true, saving: false, warned: true }),
      false,
      "🔴 the second press MUST leave — a guard he cannot get out of is a trap",
    );
  }

  // ── 2. Everything else leaves untouched ──────────────────────────────────────────────────────
  {
    assert.equal(
      shouldWarnUnsavedVoiceNote({ hasVoiceNote: false, saving: false, warned: false }),
      false,
      "no recording, no question — the form must not grow a step for a rep who did not use it",
    );
    assert.equal(
      shouldWarnUnsavedVoiceNote({ hasVoiceNote: true, saving: true, warned: false }),
      false,
      "a save is in flight: the form is already closing itself and must not be interrupted",
    );
    assert.equal(
      shouldWarnUnsavedVoiceNote({ hasVoiceNote: true, saving: true, warned: true }),
      false,
      "saving wins over every other state",
    );
  }

  // ── 3. The words ─────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(
      UNSAVED_VOICE_NOTE_WARNING,
      "Your voice note is kept when you save the visit. Leave now and it is not kept.",
      "the sentence states the mechanism; changing it means changing this rule on purpose",
    );
    assert.equal(UNSAVED_VOICE_NOTE_STAY_LABEL, "Go back and save");
    assert.equal(UNSAVED_VOICE_NOTE_LEAVE_LABEL, "Leave without it");

    // Golden Rule #1: never made to feel caught. "You forgot" is that in miniature.
    for (const forbidden of [/you forgot/i, /\bunsaved changes\b/i, /\bwarning\b/i, /\berror\b/i, /\bmust\b/i]) {
      assert.ok(
        !forbidden.test(UNSAVED_VOICE_NOTE_WARNING),
        `the sentence a rep reads must not say ${forbidden} — it is a fact about the app, not a failing of his`,
      );
    }
    // And it offers a way out in its own words, not only in a button nobody reads.
    assert.match(UNSAVED_VOICE_NOTE_LEAVE_LABEL, /leave/i, "the door out is named as a door out");
  }

  // ── 4. Both exits, on both platforms, go through the one guard ───────────────────────────────
  //
  // The back arrow and Cancel are two separate controls on each screen. A rule wired into one of
  // them is a rule that holds until the rep uses the other — and on the phone, before this change,
  // both called `onClose` directly with no guard between them at all.
  {
    for (const [label, path] of [
      ["web", "src/components/phoenix-crm/visits-tab.tsx"],
      ["phone", "mobile/src/features/crm/visits-screen.tsx"],
    ] as const) {
      const code = read(path);
      assert.match(
        code,
        /shouldWarnUnsavedVoiceNote\(\{\s*hasVoiceNote: voiceNote !== null/,
        `${label}: the screen no longer asks the guard before leaving`,
      );
      assert.match(code, /onBack=\{close\}/, `${label}: the back arrow no longer goes through the guard`);
      assert.ok(
        !/onBack=\{\(\) => \(saving \? undefined : onClose\(\)\)\}/.test(code),
        `${label}: the back arrow still calls onClose directly, so the warning never fires for it`,
      );
    }

    // The phone's Cancel button, named specifically: it is the one that was wired straight to
    // `onClose` and the one a rep on a phone actually presses.
    const phone = read("mobile/src/features/crm/visits-screen.tsx");
    assert.match(phone, /label="Cancel" onPress=\{close\}/, "the phone's Cancel no longer goes through the guard");
  }
}

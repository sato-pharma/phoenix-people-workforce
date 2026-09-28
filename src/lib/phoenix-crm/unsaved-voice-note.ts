/**
 * Phoenix CRM — leaving the visit form with a voice note that was recorded but never saved.
 *
 * WHY THIS EXISTS, measured rather than imagined. On 25 September a rep recorded NINE voice notes
 * across a full working day — 05:43 to 21:25, three of them inside one minute. All nine reached the
 * bucket. Not one was ever attached to a saved visit, and he took no photo, so no visit was recorded
 * either. The shape of it — record, record, record, never save — is what a person does when they
 * believe the recording IS the log. The app told him nothing, because a voice note is stored only
 * when the visit is saved and nothing on the form said so at the moment it mattered.
 *
 * The owner's instruction, 2026-09-28: warn a rep who leaves a recorded voice note unsaved.
 *
 * 🔴 IT WARNS, IT NEVER REFUSES. Golden Rule #1: the rep's app is EASY, and it never makes him feel
 * he is being policed. Pressing Cancel or the back arrow a second time leaves, every time, with no
 * further question — the first press shows him what he is about to lose and the second is taken at
 * his word. A guard that would not let him out is a trap, and a trap is how a rep learns to dread
 * the form.
 *
 * 🔴 AND IT SAYS WHAT HE LOSES, NOT WHAT HE DID WRONG. There is no "you forgot", no "unsaved
 * changes", no warning triangle. It states the mechanism — the note is kept when the visit is saved —
 * because the thing he is missing is a fact about the app, not a failing of his.
 *
 * Pure on purpose. This machine could not start a dev server the night it was written (1.3 GB free
 * against an 1,800 MB floor), so the decision and the wording live where a test can reach them
 * without a browser, and the screens hold only the wiring.
 */

/**
 * The sentence the rep reads. Pinned by `tests/phoenix-crm-unsaved-voice-note.test.ts`, which is the
 * point of putting a single sentence in its own constant: the next person to touch this file must
 * change a test that states the rule in order to make it accusatory.
 */
export const UNSAVED_VOICE_NOTE_WARNING =
  "Your voice note is kept when you save the visit. Leave now and it is not kept.";

/** The button that goes back to the form. */
export const UNSAVED_VOICE_NOTE_STAY_LABEL = "Go back and save";

/** The button that leaves anyway. It is always offered, and it always works. */
export const UNSAVED_VOICE_NOTE_LEAVE_LABEL = "Leave without it";

export interface UnsavedVoiceNoteState {
  /** A recording exists on the form and has not been through a save. */
  hasVoiceNote: boolean;
  /** A save is in flight — the form is already closing itself, and must not be interrupted. */
  saving: boolean;
  /** He has already been shown the warning once for this attempt to leave. */
  warned: boolean;
}

/**
 * Whether this attempt to leave should stop and show the warning.
 *
 * The `warned` flag is what makes it ONE-SHOT. Without it the second press would show the same
 * warning again and the rep could not get out at all — which is the trap this must not become, and
 * the single most likely way for a well-meant guard to turn into the opposite of Golden Rule #1.
 */
export function shouldWarnUnsavedVoiceNote(state: UnsavedVoiceNoteState): boolean {
  if (state.saving) return false;
  if (state.warned) return false;
  return state.hasVoiceNote;
}

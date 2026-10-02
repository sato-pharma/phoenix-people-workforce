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

/** The heading over that sentence: what it is about, never what he did. */
export const UNSAVED_VOICE_NOTE_TITLE = "Your voice note";

/**
 * 🔴 THE MICROPHONE IS STILL OPEN — the case the warning above could not see, because there is no
 * stored note yet to ask about.
 *
 * Found by the Phoenix CRM audit of 2026-10-02. The visit form's step 3 holds every box, including
 * the microphone; pressing Next swaps the whole of it for the read-back, so `CrmSpeak` UNMOUNTS, and
 * its cleanup CANCELS the recorder rather than stopping it — cancelled, so what was caught so far is
 * thrown away and nothing is uploaded. The rep was mid-sentence, he pressed the button the form was
 * telling him to press, and the recording was gone with no word said. Pressing Back did the same, and
 * the one-shot warning above never fired because `voiceNote` was still null — the note only exists
 * after Stop.
 *
 * So the two presses are answered with what is actually happening. Next STOPS and says why: he is not
 * leaving, he is carrying on, and Stop is one tap away — blocking it loses him nothing and keeps the
 * recording. Back still WARNS ONCE and then goes, exactly as it does for a stored note: a guard he
 * cannot get out of is the trap Golden Rule #1 forbids.
 */
export const RECORDING_IN_FLIGHT_TITLE = "Your recording";

export const RECORDING_IN_FLIGHT_WARNING =
  "Your recording is still running. Press Stop and it is kept with the visit. Leave now and it is not kept.";

/** The same fact where he is NOT leaving: he pressed Next, and Next is where it used to vanish. */
export const RECORDING_IN_FLIGHT_NEXT =
  "Press Stop first — your recording is still running, and going on now would lose it.";

/** The button that goes back to the form. */
export const UNSAVED_VOICE_NOTE_STAY_LABEL = "Go back and save";

/** The button that leaves anyway. It is always offered, and it always works. */
export const UNSAVED_VOICE_NOTE_LEAVE_LABEL = "Leave without it";

export interface UnsavedVoiceNoteState {
  /** A recording exists on the form and has not been through a save. */
  hasVoiceNote: boolean;
  /** The microphone is open, or the recording is still going up. Nothing is stored yet. */
  recording?: boolean;
  /** A save is in flight — the form is already closing itself, and must not be interrupted. */
  saving: boolean;
  /** He has already been shown the warning once for this attempt to leave. */
  warned: boolean;
}

/** What the bar says when an attempt to leave is stopped: the heading, and the one sentence under it. */
export type VoiceNoteLeaveWarning = { title: string; message: string };

/**
 * The warning this attempt to leave should show, or null to go.
 *
 * The microphone comes first: a running recording is the one that is lost the moment he goes, and it
 * is also the only one with a way to keep it (Stop). A stored note falls through to the sentence
 * above it.
 *
 * The `warned` flag is what makes it ONE-SHOT. Without it the second press would show the same
 * warning again and the rep could not get out at all — which is the trap this must not become, and
 * the single most likely way for a well-meant guard to turn into the opposite of Golden Rule #1.
 */
export function voiceNoteLeaveWarning(state: UnsavedVoiceNoteState): VoiceNoteLeaveWarning | null {
  if (state.saving || state.warned) return null;
  if (state.recording) return { title: RECORDING_IN_FLIGHT_TITLE, message: RECORDING_IN_FLIGHT_WARNING };
  return state.hasVoiceNote ? { title: UNSAVED_VOICE_NOTE_TITLE, message: UNSAVED_VOICE_NOTE_WARNING } : null;
}

/** The same question as a yes or no, for a caller that only has to decide whether to stop. */
export function shouldWarnUnsavedVoiceNote(state: UnsavedVoiceNoteState): boolean {
  return voiceNoteLeaveWarning(state) !== null;
}

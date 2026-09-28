/**
 * THE PHONE'S MIRROR of `src/lib/phoenix-crm/unsaved-voice-note.ts`.
 *
 * `mobile/` is its own TypeScript project and cannot import the web module, so this is transcribed by
 * hand and compared by `tests/phoenix-crm-mobile-mirrors.test.ts` — constant for constant and
 * sentence for sentence. THE REP READS THE PHONE'S COPY, so a sentence that drifts here is the one he
 * actually gets, and nothing else in the build would notice.
 *
 * Why it exists at all: a rep on production recorded nine voice notes across a working day and lost
 * every one, because a note is kept only when the visit is saved and nothing said so at the moment
 * it mattered. The owner's instruction, 2026-09-28: warn a rep who leaves a recorded voice note
 * unsaved.
 *
 * 🔴 IT WARNS, IT NEVER REFUSES. The second press always leaves. A guard a rep cannot get out of is
 * a trap, and a trap is the opposite of Golden Rule #1.
 */

export const UNSAVED_VOICE_NOTE_WARNING =
  "Your voice note is kept when you save the visit. Leave now and it is not kept.";

export const UNSAVED_VOICE_NOTE_STAY_LABEL = "Go back and save";

export const UNSAVED_VOICE_NOTE_LEAVE_LABEL = "Leave without it";

export interface UnsavedVoiceNoteState {
  hasVoiceNote: boolean;
  saving: boolean;
  warned: boolean;
}

/** One-shot: `warned` is what stops the second press showing the same warning for ever. */
export function shouldWarnUnsavedVoiceNote(state: UnsavedVoiceNoteState): boolean {
  if (state.saving) return false;
  if (state.warned) return false;
  return state.hasVoiceNote;
}

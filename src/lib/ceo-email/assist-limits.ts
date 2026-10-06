/**
 * The assistant's input ceilings, with nothing server-only in the file.
 *
 * 🔴 SPLIT OUT SO THE SCREEN AND THE ROUTE READ THE SAME NUMBERS. The route slices the instruction
 * at `CEO_ASSIST_MAX_INSTRUCTION_CHARS`; if the textarea's `maxLength` were a second copy of that
 * figure, a smaller one would stop him mid-sentence and a larger one would silently drop the second
 * half of a briefing on the way to the server — with nothing on screen saying so.
 *
 * It cannot come from `./assist.ts`, which imports the OpenAI client: a client component importing
 * that module would pull the API key's reader and the model plumbing into the browser bundle. Same
 * split, and the same reason, as `sato-email/media-limits.ts` and `./dictation-limits.ts`.
 */

/** The composer's own subject cap, so a draft can never be one the send route would reject. */
export const CEO_ASSIST_MAX_SUBJECT_CHARS = 200;

/** A generous letter. Longer than this and he is writing a document, not an email. */
export const CEO_ASSIST_MAX_BODY_CHARS = 40_000;

/**
 * How much he may say in the instruction box.
 *
 * Higher than the Sato composer's 4,000 for one measured reason: this box is also a MICROPHONE, and
 * spoken instruction runs far longer than typed. Three minutes of dictation — the recording cap in
 * `./dictation-limits.ts` — is comfortably over 4,000 characters, and cutting it mid-sentence
 * silently drops the half that carried the facts.
 */
export const CEO_ASSIST_MAX_INSTRUCTION_CHARS = 6_000;

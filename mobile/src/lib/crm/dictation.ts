/**
 * Phoenix CRM — adding spoken words to a typed comment, on the phone.
 *
 * A COPY of the web's `appendDictated` (src/lib/phoenix-crm/dictation.ts), deliberately, because the app
 * is a separate bundle with its own tsconfig and cannot import the web tree — the same reason
 * `VISIT_COMMENT_MAX` is restated in `./entry-rules.ts`. Kept identical line for line and pinned by
 * tests/mobile-crm-voice-comment.test.ts, which runs this and the web original side by side and fails on
 * any difference, so the two clients can never disagree about what "append" means.
 *
 * IT LIVES IN ITS OWN FILE, apart from `./voice.ts`, for one mechanical reason: `voice.ts` imports
 * `expo-audio` and `expo-file-system` at the top, which the root Node test suite cannot resolve, so a test
 * that reached this function through `voice.ts` would crash on import. This module is pure — no React
 * Native, no I/O — so the root suite imports it directly, exactly as the parity test imports the pure
 * `evidence-stamp.ts`. `voice.ts` re-exports it, so the app still imports everything from one place.
 */

/**
 * Add spoken words to what is already typed, without ever replacing it.
 *
 * It APPENDS. The rep may have typed something already, and the words arrive seconds after he stopped
 * talking — long enough for him to have started typing — so overwriting the field is how a comment
 * disappears. At the cap it trims the SPOKEN half at a word boundary and keeps every character he typed.
 */
export function appendCrmDictated(existing: string, spoken: string, max: number): string {
  const phrase = spoken.replace(/\s+/g, " ").trim();
  if (!phrase) return existing;

  const head = existing.trimEnd();
  const joined = head ? `${head} ${phrase}` : phrase;
  if (joined.length <= max) return joined;

  const room = max - (head ? head.length + 1 : 0);
  if (room <= 0) return existing;

  const fitted = phrase.slice(0, room);
  const lastSpace = fitted.lastIndexOf(" ");
  const kept = (lastSpace > 0 ? fitted.slice(0, lastSpace) : fitted).trimEnd();
  if (!kept) return existing;
  return head ? `${head} ${kept}` : kept;
}

/**
 * The `notes` column on an attendance exception has two authors: the employee (or the admin filing
 * on their behalf) writes it when the dispute is raised, and the reviewer can add to it when they
 * approve or reject. One column, two writers — so the review step must never assume its own payload
 * is the whole truth about that cell.
 *
 * These helpers apply ordinary PATCH semantics, the same rule already used for hiring document
 * statuses:
 *
 *   - key absent      -> leave the stored note exactly as it is
 *   - explicit null   -> clear it
 *   - a string        -> write it trimmed; whitespace-only trims to a clear
 *
 * Before this rule existed, the reviewer's empty "Notes (optional)" box was sent as an explicit
 * null and written straight over the requester's note — the note the row renders directly above
 * that box. Approving a dispute without typing anything erased the reason it was raised.
 */

/**
 * Reads `notes` off a raw request body, preserving the difference between "not sent" and "sent as
 * null". `JSON.stringify` drops undefined keys, so a client that omits the field arrives here with
 * no key at all — which must not be read as a request to clear.
 */
export function readAttendanceExceptionNotes(
  payload: Record<string, unknown>,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, "notes")) return undefined;
  const value = payload.notes;
  return typeof value === "string" ? value : null;
}

/**
 * Turns an incoming note into the columns a partial update should carry. An absent note yields an
 * empty object, so the column is left out of the `.update()` entirely and Postgres does not touch
 * it — which is stronger than reading a before-image and writing it back.
 */
export function resolveAttendanceExceptionNotesPatch(
  incoming: string | null | undefined,
): { notes?: string | null } {
  if (incoming === undefined) return {};
  const text = incoming?.trim();
  return { notes: text ? text : null };
}

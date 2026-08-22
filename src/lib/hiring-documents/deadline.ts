// ─────────────────────────────────────────────────────────────────────────────
// Hiring document deadlines: deciding whether a blur is actually an edit.
//
// The deadline field on a missing document saves on blur, because a date picker has no natural
// "done" button. Blurring is not editing, though — tabbing across a row, or opening the picker and
// closing it again, leaves the value exactly as it was and must not reach the database. Every one
// of those no-op writes stamps `updated_at` on a real production row and, since hiring document
// writes are not audited, leaves no way to tell it apart afterwards from a deliberate change.
//
// This module is deliberately free of React and of anything server-only: the manager component is
// a client component, so the rule it enforces has to be importable from the browser bundle.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two spellings of "no deadline" collapsed into one.
 *
 * An empty `<input type="date">` reads as `""`; the API payload and the database column both use
 * `null`. Comparing the raw values would read a cleared field as a change on every blur, which is
 * the same spurious write in the other direction.
 */
export function normalizeHiringDeadline(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

/**
 * True when a deadline field genuinely changed during one focus-to-blur interaction.
 *
 * `previous` is the value the input held when it gained focus, not the value in state: the field's
 * own `onChange` writes straight into the dashboard data so the controlled input stays typeable, so
 * by blur time state already agrees with the box and has nothing left to compare against.
 */
export function hiringDeadlineChanged(
  previous: string | null | undefined,
  next: string | null | undefined,
): boolean {
  return normalizeHiringDeadline(previous) !== normalizeHiringDeadline(next);
}

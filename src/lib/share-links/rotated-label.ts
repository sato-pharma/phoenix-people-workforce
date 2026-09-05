/**
 * The label a rotated share link inherits from the one it replaces.
 *
 * WHY THIS IS NOT `${old.label} (rotated)`.
 *
 * That was the original, in all three rotations, and it appends unconditionally. A rotation copies
 * the label it just wrote, so every run adds ten more characters to a string that is never reset —
 * and these rotations run WEEKLY, unattended. By 2026-09-05 the live marketing feed link was
 * already carrying five of them:
 *
 *   Owner live Google Sheet feed (all marketing requests, files on) (rotated 2026-08-05)
 *     (rotated) (rotated) (rotated) (rotated) (rotated)
 *
 * — 134 characters, growing by ten a week, in a column a human reads on the share-links screen to
 * decide which link is which. Direct orders had four. Nothing was broken, which is exactly why it
 * survived: an unbounded string that grows slowly looks like data until it looks like a bug.
 *
 * So the suffix is normalised rather than appended: any run of trailing ` (rotated)` markers is
 * stripped first, and exactly one is put back. That makes the function IDEMPOTENT —
 * `rotatedLabel(rotatedLabel(x)) === rotatedLabel(x)` — so the label reaches a fixed point on the
 * first rotation and stays there however many times it runs.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. Only the bare literal ` (rotated)` is stripped. A label a
 * human wrote, including one shaped like `(rotated 2026-08-05)`, carries a date and is therefore a
 * note somebody chose to leave — it survives untouched. And the marker stays undated on purpose:
 * a dated one would either accrete exactly like the old bug, or need a pattern loose enough to eat
 * that human note. The row's own `created_at` already says when the rotation happened, to the
 * millisecond, and it cannot drift from the truth the way a hand-built string can.
 *
 * @param previous The label on the link being replaced, whatever the database returned for it.
 * @param fallback The label to use when there is nothing to inherit — a per-report default, since
 *   "Rotated feed link" means something different on each of the three reports.
 */
export function rotatedLabel(previous: unknown, fallback: string): string {
  const base = typeof previous === "string" ? previous.trim() : "";
  if (!base) return fallback;

  const stripped = base.replace(/(?:\s*\(rotated\))+$/i, "").trim();
  // A label that was ONLY markers leaves nothing to inherit, so the caller's default is better
  // than the bare marker standing alone as a name.
  return stripped ? `${stripped} (rotated)` : fallback;
}

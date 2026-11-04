import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { periodLabel } from "@/lib/sales/monthly-closing-period-merge";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — a lock request for a month that is ALREADY locked.
//
// Measured on production 2026-11-04: the owner published Anti Infective 2026-10, the publication
// trigger (`phx_freeze_published_closing`) locked the month in the same transaction — lock and
// publication carry the same 17:36:45.851168 UTC — and the screen, which did not re-read the lock
// after Publish, still offered "Lock month". His press 14 seconds later hit the unique index
// `monthly_closing_locks_one_active` (23505), and the owner of a correctly locked month was told
// "Lock request failed." while two app_error_events rows were written for nothing.
//
// The month being locked is exactly what the request asked for, so it is answered as success —
// "already locked, by whom, when" — never as an error and never as an error row. PURE: nothing here
// reads the database, so the test drives it directly.
// ─────────────────────────────────────────────────────────────────────────────

/** True when the lock insert lost to the one-active-lock unique index: the month is already locked. */
export function isActiveLockConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; details?: unknown; message?: unknown };
  if (String(candidate.code ?? "") !== "23505") return false;
  return /monthly_closing_locks_one_active/.test(`${String(candidate.message ?? "")} ${String(candidate.details ?? "")}`);
}

/**
 * "October 2026 Anti Infective is already locked, by Omar Gawish at 04 Nov 2026 · 19:36 Cairo time."
 * A name or a time that could not be read is left out rather than replaced by an HR id or a guess.
 */
export function describeAlreadyLocked(input: {
  line: string;
  lockedAt: string | null | undefined;
  lockedByName: string | null | undefined;
  period: string;
}): string {
  const by = input.lockedByName ? `, by ${input.lockedByName}` : "";
  const when = cairoDateTime(input.lockedAt);
  const at = when === "—" ? "" : ` at ${when} Cairo time`;
  return `${periodLabel(input.period)} ${input.line} is already locked${by}${at}.`;
}

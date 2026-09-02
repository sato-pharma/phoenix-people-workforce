// Shared formatting for every Early Birds surface. One place, so a start time never renders one way
// on the race panel and another on the winner card.

/** "08:42" from minutes past Cairo midnight. Never an ellipsis, never a wrap. */
export function formatStartClock(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** "12 Mar 2023" — a hire date is a fact about a person, so it reads like one.
 *
 * DATE-ONLY (`employees.hire_date`, a `date` column), pinned to UTC midnight. UTC here is
 * CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset.
 * Same for formatDayShort below. Neither is an instant — do not "fix" them to Cairo. */
export function formatHireDate(dateIso: string | null | undefined): string {
  if (!dateIso) return "—";
  const parsed = new Date(`${String(dateIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Day-of-month for the timeline strip. */
export function formatDayNumber(dateIso: string): string {
  return String(Number(dateIso.slice(8, 10)));
}

export function formatDayShort(dateIso: string): string {
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateIso;
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Points out of 1000 — a whole number reads as a score; 0.812345 reads as a bug. */
export function formatPoints(totalScore: number): string {
  return String(Math.round(totalScore * 1000));
}

/**
 * The start-time tiers used by both the timeline cells and the streak strip. Before 09:00 is the
 * target, 09:00-10:00 acceptable, after 10:00 late, and a day with no visit is inert rather than
 * red — a weekly off is not a failure.
 */
export function startTierClass(minutes: number | null, expectedWeight: number): string {
  if (minutes === null) return expectedWeight > 0 ? "bg-slate-200" : "bg-slate-100";
  if (minutes < 9 * 60) return "bg-emerald-500";
  if (minutes < 10 * 60) return "bg-amber-400";
  return "bg-orange-500";
}

export function startTierLabel(minutes: number | null, expectedWeight: number): string {
  if (minutes === null) return expectedWeight > 0 ? "No visit" : "Off";
  if (minutes < 9 * 60) return "Before 09:00";
  if (minutes < 10 * 60) return "09:00-10:00";
  return "After 10:00";
}

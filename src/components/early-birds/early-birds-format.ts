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
 * "Sep 1-15" — the fortnight, short enough to sit in a picker chip.
 *
 * The full `period.label` ("September 1-15, 2026") is what every heading and history row carries;
 * this is only for the switcher, where a dozen of them sit side by side. Derived from the period's
 * own start and end dates rather than re-deriving 1-15 / 16-end, so a February fortnight ends on
 * the 28th or 29th exactly as the period module computed it.
 */
export function formatPeriodChip(period: { startIso: string; endIso: string }): string {
  const month = new Date(`${period.startIso}T00:00:00Z`);
  if (Number.isNaN(month.getTime())) return `${period.startIso} - ${period.endIso}`;
  const monthLabel = month.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${monthLabel} ${Number(period.startIso.slice(8, 10))}-${Number(period.endIso.slice(8, 10))}`;
}

/**
 * How much earlier (or later) one median start is than another — "24 min earlier".
 *
 * Phrased in the EARLIER direction on purpose. This board rewards starting early, so an improving
 * rep's delta is a negative number of minutes, and rendering a bare "-24" in front of a manager
 * reads as a fall. Null when either side has no verified start: "no change" would be a claim, and
 * a rep with no GPS check-in has not been measured rather than stayed the same.
 */
export function formatStartDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
): { text: string; earlier: boolean } | null {
  if (typeof current !== "number" || typeof previous !== "number") return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const delta = Math.round(previous - current);
  if (delta === 0) return { text: "same start", earlier: false };
  return { text: `${Math.abs(delta)} min ${delta > 0 ? "earlier" : "later"}`, earlier: delta > 0 };
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

/**
 * The board's heading for the fortnight on screen.
 *
 * "This fortnight · September 1-15, 2026" was hard-coded, which was true for as long as the board
 * could only ever show the live half-month. The period picker (2026-09-18) makes a closed fortnight
 * reachable, and that heading then tells a manager reading August in September that August is the
 * fortnight he is in. The period is named either way - only the claim about WHEN it is changes.
 */
export function formatFortnightHeading(periodLabel: string, closed: boolean): string {
  return `${closed ? "Fortnight" : "This fortnight"} · ${periodLabel}`;
}

/**
 * What the board's figures are ABOUT, when it is showing one district out of a wider scope.
 *
 * The page resolves `scope.scopeLabel` for the VIEWER ("your line", "the company") and the board
 * shows ONE district of it — a National Sales Manager lands on the first of his six districts. The
 * tiles used to read "across your line" and the chip "Your line · 6 districts" over that one
 * district's figures (owner audit, 2026-10-26). "Your line" is true only when the whole line is on
 * screen, which is `districtCount <= 1`; otherwise the district shown is named. A vacant seat is
 * named by its region ("Vacant — Alex Center"), never by the departed manager's HR id.
 */
export function formatShownScopeLabel(input: {
  scopeLabel: string;
  districtCount: number;
  districtName: string;
}): string {
  if (input.districtCount <= 1) return input.scopeLabel;
  const name = input.districtName.trim();
  const vacant = /^Vacant\s*[—–-]\s*(.+)$/.exec(name);
  if (vacant) return `the vacant ${vacant[1]} district`;
  if (!name || /^Vacant(\s|$)/i.test(name)) return "the vacant district";
  return `${name}'s district`;
}

/** The scope chip when several districts are selectable: how many, and of what — never "the line" itself. */
export function formatDistrictCountChip(scopeLabel: string, districtCount: number): string {
  return `One of ${districtCount} districts in ${scopeLabel}`;
}

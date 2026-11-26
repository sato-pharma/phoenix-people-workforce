/**
 * The rules of the Rep visits export page's rep desk (owner, 26 Nov 2026: "make me able to for example
 * filter line pedia probation status critical and filter from their hire date to utd"; "one or multiple as i
 * want"). Plain functions, shared by the page's client desk and the tests, so what is tested is what runs.
 */

/**
 * Where a rep stands on probation, as the Probation tracker shows it: one of its four zones, "none" when
 * the rep is not on the tracker (passed, or hired long ago), or "unread" when the tracker could not be
 * read — said as such, never shown as "not on probation".
 */
export type RepProbationStanding = "critical" | "warning" | "safe" | "overdue" | "none" | "unread";

export type RepProbationFilter = "any" | "on" | "critical" | "warning" | "safe" | "overdue" | "none";

/** The tracker's own thresholds: critical under 30 days left, warning 30 to 60, safe over 60. */
export const REP_PROBATION_FILTERS: { value: RepProbationFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "on", label: "On probation" },
  { value: "critical", label: "Critical (under 30 days left)" },
  { value: "warning", label: "Warning (30 to 60 days left)" },
  { value: "safe", label: "Safe (over 60 days left)" },
  { value: "overdue", label: "Ended, decision overdue" },
  { value: "none", label: "Not on probation" },
];

/** An unread tracker filters nobody out: the page says the filter is off rather than hide every rep. */
export function probationMatches(standing: RepProbationStanding, filter: RepProbationFilter): boolean {
  if (filter === "any" || standing === "unread") return true;
  if (filter === "on") return standing === "critical" || standing === "warning" || standing === "safe" || standing === "overdue";
  return standing === filter;
}

type DeskRep = { name: string; hireDate: string | null };
type Period = { from: string; to: string } | { error: string };

/**
 * One rep's visits range. From the hire date: hire date to today, but never further back than the export's
 * day limit (`maxDays` days, today included) — the route refuses a longer range.
 */
export function visitsPeriodFor(
  rep: DeskRep,
  input: { from: string; to: string; fromHire: boolean; today: string; maxDays: number },
): Period {
  let { from, to } = input;
  if (input.fromHire) {
    if (!rep.hireDate) return { error: `${rep.name} has no hire date on the employee record. Remove the rep or untick "From each rep's hire date".` };
    const floor = addDays(input.today, -(input.maxDays - 1));
    from = rep.hireDate > floor ? rep.hireDate : floor;
    to = input.today;
  }
  if (!from || !to) return { error: "Choose a from date and a to date." };
  if (from > to) return { error: input.fromHire ? `${rep.name}'s hire date is after today.` : "The from date must be on or before the to date." };
  return { from, to };
}

/** One rep's review months. From the hire month: hire month to this month, at most `maxMonths` months. */
export function reviewPeriodFor(
  rep: DeskRep,
  input: { from: string; to: string; fromHire: boolean; today: string; maxMonths: number },
): Period {
  let { from, to } = input;
  if (input.fromHire) {
    if (!rep.hireDate) return { error: `${rep.name} has no hire date on the employee record. Remove the rep or untick "From each rep's hire month".` };
    const current = input.today.slice(0, 7);
    const floor = addMonths(current, -(input.maxMonths - 1));
    const hireMonth = rep.hireDate.slice(0, 7);
    from = hireMonth > floor ? hireMonth : floor;
    to = current;
  }
  if (!from || !to) return { error: "Choose a from month and a to month." };
  if (from > to) return { error: input.fromHire ? `${rep.name}'s hire month is after this month.` : "The from month must be on or before the to month." };
  return { from, to };
}

/** The file name the route gave, from its `content-disposition`. */
export function fileNameOf(disposition: string | null): string | null {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  return match ? match[1] : null;
}

/** How long to wait on a 429, from its Retry-After: what the route says, held between 5 and 90 seconds. */
export function retryWaitSeconds(retryAfter: string | null): number {
  return Math.min(Math.max(Number(retryAfter) || 30, 5), 90);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SUPER ADMIN'S REP EXCEPTIONS — any rep, a switch and the dates.
//
// Owner, 2026-11-03: "build a module for admin only to open or close this feature by a toggle or be able to
// control duration for any rep if needed exception".
//
// A rep's exception is a dated row on `phoenix_crm_offplan_exemptions`, the row the visit door already reads, so
// it lifts the 2 a day and 8 a week and nothing else. On the day after the last date the usual limit returns with
// no job and no hand. Closing it or moving its dates never rewrites a visit already logged.
//
// The account, and what stays untouched: docs/phoenix-crm-offplan-exemptions.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const REP_EXCEPTIONS_ADMIN_PATH = "/admin/field-crm/rep-exceptions";

export const REP_EXCEPTION_DATES_TEXT = "Choose a first day and a last day. The last day must not be before the first day or before today.";

export const REP_EXCEPTION_ACTIONS = ["open", "close"] as const;

export type RepExceptionAction = (typeof REP_EXCEPTION_ACTIONS)[number];

export function parseRepExceptionAction(value: unknown): RepExceptionAction | null {
  const key = String(value ?? "").trim();
  return REP_EXCEPTION_ACTIONS.find((action) => action === key) ?? null;
}

function realIsoDay(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

/** Dates the page may save, or the sentence that says why not. The database asks the same again. */
export function repExceptionDatesProblem(from: unknown, until: unknown, today: string): string | null {
  const first = realIsoDay(from);
  const last = realIsoDay(until);
  if (!first || !last || first > last || last < today) return REP_EXCEPTION_DATES_TEXT;
  return null;
}

/** One calendar month from `day`, less a day: 1 November gives 30 November, 24 October gives 23 November. */
export function lastDayOfOneMonth(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const lastOfNextMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const landed = new Date(Date.UTC(year, month, Math.min(date, lastOfNextMonth)));
  landed.setUTCDate(landed.getUTCDate() - 1);
  return landed.toISOString().slice(0, 10);
}

/** What the dates start as for a rep with no live window: the hire month if it is still running, else from today. */
export function suggestedRepExceptionWindow(hireDate: string | null, today: string): { from: string; until: string } {
  const hired = realIsoDay(hireDate);
  const from = hired && hired <= today && lastDayOfOneMonth(hired) >= today ? hired : today;
  return { from, until: lastDayOfOneMonth(from) };
}

export type RepExceptionRow = {
  hrId: string;
  name: string;
  lineName: string;
  areaName: string;
  hireDate: string | null;
  /** True while a row is open and its last day has not passed: exactly when the door can still match it. */
  on: boolean;
  /** The dates the controls start with: the live window, or a suggestion when the switch is off. */
  from: string;
  until: string;
  setByName: string | null;
  setAt: string | null;
};

export type RepExceptionPick = { hrId: string; name: string; lineName: string; areaName: string };

export type RepExceptionsAdminView = {
  today: string;
  offPlanDailyCap: number;
  offPlanWeeklyCap: number;
  reps: RepExceptionPick[];
  selected: RepExceptionPick | null;
  /** Every rep with a live exception. The page opens on these, whatever the filter says. */
  exceptions: RepExceptionRow[];
  /** The ordinary module under them: the chosen rep, or everyone who once had one and has none now. */
  rows: RepExceptionRow[];
};

export type StoredRepWindow = {
  seatId: string;
  from: string;
  until: string;
  endedAt: string | null;
  grantedBy: string | null;
  createdAt: string | null;
};

/**
 * One person's standing from the dated rows on the seats that person holds now. A row on a seat the rep has left can
 * never match at the door, so it never reads as on. The latest last day wins if two seats ever differ.
 */
export function repStanding(
  stored: ReadonlyArray<StoredRepWindow>,
  seatIds: ReadonlyArray<string>,
  today: string,
): { on: boolean; live: StoredRepWindow | null } {
  const seats = new Set(seatIds);
  const live = stored
    .filter((row) => seats.has(row.seatId) && row.endedAt === null && row.until >= today)
    .sort((left, right) => (left.until < right.until ? 1 : left.until > right.until ? -1 : 0))[0];
  return { on: Boolean(live), live: live ?? null };
}

/** The page's one note: what the switch moves, and what stays. */
export function repExceptionsExplainer(view: Pick<RepExceptionsAdminView, "offPlanDailyCap" | "offPlanWeeklyCap">): string {
  return `Switching a rep on removes the limit of ${view.offPlanDailyCap} unplanned visits a day and ${view.offPlanWeeklyCap} a week between the two dates, first and last day included. The usual limit returns by itself on the day after the last date. Approval and each polyclinic's own daily number stay as they are, and visits already logged do not change. It applies to the rep named here only, so another rep on the same territory keeps the usual limit. Nobody is notified.`;
}

/** The words beside the switch. `formatDay` is the page's own date format. */
export function repExceptionStateLabel(row: Pick<RepExceptionRow, "on" | "from" | "until">, today: string, formatDay: (day: string) => string): string {
  if (!row.on) return "Usual limit";
  return row.from > today ? `No limit from ${formatDay(row.from)} until ${formatDay(row.until)}` : `No limit until ${formatDay(row.until)}`;
}

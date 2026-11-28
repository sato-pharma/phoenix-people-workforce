/**
 * Phoenix CRM — the Far-visit week: the rules a reader sees, with no database in them (owner, 28 Nov 2026: "list his
 * week … Sunday green clean, Saturday and Monday 8 rejected … names and full details … open it and export it to
 * Excel").
 *
 * One row per rep, one cell per day of the company week (Saturday to Friday, the week every plan is filed for), and
 * a cell is one of four standings:
 *   - `clean`    — visits logged and nothing refused or held: green, and nothing to open;
 *   - `rejected` — at least one visit refused for where it was logged, at the door or by the SFE: red, it opens;
 *   - `waiting`  — no refusal but a far visit still waiting for the SFE: amber, it opens;
 *   - `none`     — no visit and nothing refused: a plain dash (a day off, a leave, a Friday).
 *
 * 🔴 A far try is REJECTED AT ONCE AND NEVER ACCEPTED (owner, 28 Nov 2026: "It is not rejected after it is submitted …
 * It is rejected at once, never accepted. The accepted is the one meeting our criteria, and the rep tries is saved here").
 * Every refused try counts as rejected, one per customer per day. When the rep then logged that customer from the
 * right place the same day, that is a separate accepted visit, and the detail says so beside the refused tries.
 */

export type FarVisitWeekStanding = "clean" | "rejected" | "waiting" | "none";

export type FarVisitWeekCellCounts = {
  /** Visits logged that day (the rep's own entries, never a copied iReports360 one). */
  visits: number;
  /** Customers whose visit was refused when saved, for being away from their place (one per customer per day). */
  doorRejected: number;
  /** Far visits the SFE refused. */
  sfeRejected: number;
  /** Far visits still waiting for the SFE. */
  waiting: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function addDays(day: string, count: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + count * DAY_MS).toISOString().slice(0, 10);
}

/** The Saturday that opens the company week holding this day. */
export function weekSaturday(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
  return addDays(day, -((weekday + 1) % 7));
}

export type FarVisitWeek = { start: string; end: string; days: string[]; previous: string; next: string | null };

/**
 * The week a reader asked for: any day inside it moves to its Saturday; nothing, or nonsense, is this week. A week
 * that has not begun yet is never offered — `next` is null on the current week.
 */
export function farVisitWeek(raw: string | null | undefined, today: string): FarVisitWeek {
  const thisWeek = weekSaturday(today);
  const asked = raw && isDay(raw) ? weekSaturday(raw) : thisWeek;
  const start = asked > thisWeek ? thisWeek : asked;
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  return { start, end: days[6], days, previous: addDays(start, -7), next: start < thisWeek ? addDays(start, 7) : null };
}

export function farVisitWeekStanding(cell: FarVisitWeekCellCounts): FarVisitWeekStanding {
  if (cell.doorRejected + cell.sfeRejected > 0) return "rejected";
  if (cell.waiting > 0) return "waiting";
  return cell.visits > 0 ? "clean" : "none";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The cell's words: what the day was, in one short line and its visits under it. */
export function farVisitWeekCellText(cell: FarVisitWeekCellCounts): { head: string; foot: string } {
  const standing = farVisitWeekStanding(cell);
  const foot = cell.visits > 0 ? plural(cell.visits, "visit", "visits") : "No visits";
  if (standing === "rejected") {
    const rejected = cell.doorRejected + cell.sfeRejected;
    return { head: plural(rejected, "rejected", "rejected"), foot: cell.waiting > 0 ? `${foot} · ${cell.waiting} waiting` : foot };
  }
  if (standing === "waiting") return { head: `${cell.waiting} waiting`, foot };
  if (standing === "clean") return { head: "Clean", foot };
  return { head: "—", foot: "" };
}

/** How a detail line came to be, in words. */
export const FAR_VISIT_WEEK_KIND_LABELS = {
  door: "Rejected when saved",
  sfe: "Rejected by the SFE",
  waiting: "Waiting for the SFE",
} as const;

export type FarVisitWeekKind = keyof typeof FAR_VISIT_WEEK_KIND_LABELS;

/** "Mon 24 Nov" — the column head. */
export function farVisitWeekDayLabel(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  const weekday = at.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
  const date = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${weekday} ${date}`;
}

/** The map's three points, in the manager's words (the rep's own map says "you"). */
export const FAR_VISIT_WEEK_POINT_LABELS = {
  submitted: "Where the rep pressed save",
  place: "The customer's saved place",
  photo: "Where the place's photo was captured",
} as const;

/** Where the report lives: the Super Admin's and the SFE Manager's page, and the managers' copy in the portal. */
export const FAR_VISIT_WEEK_PATHS = {
  admin: "/admin/phoenix-crm/far-visit-week",
  portal: "/employee-portals/far-visit-week",
} as const;

/** How many weeks one reading may hold, and how far back the picker reaches. */
export const FAR_VISIT_WEEK_MAX = 8;
export const FAR_VISIT_WEEK_CHOICES = 12;

/**
 * SEVERAL WEEKS AT ONCE (owner, 28 Nov 2026: "multi select multi weeks"). Each value in the address moves to its
 * Saturday (`farVisitWeek`), repeats fold into one, the newest comes first, and no more than `FAR_VISIT_WEEK_MAX`
 * are read; nothing, or only nonsense, is this week alone.
 */
export function farVisitWeeks(raws: readonly string[], today: string): FarVisitWeek[] {
  const seen = new Map<string, FarVisitWeek>();
  for (const raw of raws) {
    if (!raw || !isDay(raw)) continue;
    const week = farVisitWeek(raw, today);
    seen.set(week.start, week);
  }
  const weeks = [...seen.values()].sort((a, b) => b.start.localeCompare(a.start)).slice(0, FAR_VISIT_WEEK_MAX);
  return weeks.length > 0 ? weeks : [farVisitWeek(null, today)];
}

/** The weeks the picker offers: this week and the ones before it, newest first. */
export function farVisitWeekChoices(today: string, count: number = FAR_VISIT_WEEK_CHOICES): FarVisitWeek[] {
  const thisWeek = weekSaturday(today);
  return Array.from({ length: count }, (_, index) => farVisitWeek(addDays(thisWeek, -7 * index), today));
}

/** "Sat 21 Nov to Fri 27 Nov 2026" — a week in words. */
export function farVisitWeekRangeLabel(week: Pick<FarVisitWeek, "start" | "end">): string {
  return `${farVisitWeekDayLabel(week.start)} to ${farVisitWeekDayLabel(week.end)} ${week.end.slice(0, 4)}`;
}

/**
 * The three filters above the week (owner, 28 Nov 2026: "filter by district manager … or by line or by rep"). Each
 * is a value from the address and nothing else: `dm` a district manager's SEAT id (or `none` for the reps with no
 * district manager above them), `line` the line's name, `rep` the rep's territory seat id. They narrow the rows, the
 * totals, the day detail and the Excel file together, and never widen what the reader's scope already holds.
 */
export type FarVisitWeekFilter = { dm: string | null; line: string | null; rep: string | null };

/** The `dm` value for the reps no district manager sits above. */
export const FAR_VISIT_WEEK_NO_DISTRICT = "none";

export const FAR_VISIT_WEEK_FILTER_NAMES = ["dm", "line", "rep"] as const;

export function parseFarVisitWeekFilter(read: (name: string) => string | null | undefined): FarVisitWeekFilter {
  const clean = (name: string): string | null => {
    const value = (read(name) ?? "").trim();
    return value ? value.slice(0, 200) : null;
  };
  return { dm: clean("dm"), line: clean("line"), rep: clean("rep") };
}

export function farVisitWeekFilterNarrows(filter: FarVisitWeekFilter): boolean {
  return Boolean(filter.dm || filter.line || filter.rep);
}

/**
 * The address of a week with the filters kept: every link on the page (the week arrows, a day, the Excel file)
 * goes through here, so moving a week or opening a day never drops what the reader filtered by.
 */
export function farVisitWeekQuery(weeks: string | readonly string[], filter: FarVisitWeekFilter, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const week of typeof weeks === "string" ? [weeks] : weeks) params.append("week", week);
  for (const name of FAR_VISIT_WEEK_FILTER_NAMES) {
    const value = filter[name];
    if (value) params.set(name, value);
  }
  for (const [name, value] of Object.entries(extra)) params.set(name, value);
  return `?${params.toString()}`;
}

/**
 * Phoenix CRM — the exceptions board: the few territories that need a manager today.
 *
 * Owner, 2026-09-26. A District Manager opening the Team tab sees every seat he holds, in a list of
 * the same shape whether the week went perfectly or not — so the seven that need him look exactly
 * like the sixty-one that do not. This turns the same data inside out: a territory with nothing wrong
 * is **ABSENT**, and what is left is a short list, worst first.
 *
 * ## 🔴 A seat with nothing wrong is ABSENT, never a green row
 *
 * That is the whole feature. A board that lists all 68 territories and colours 8 of them is the Team
 * tab again with extra ink; the manager still has to read 68 rows to find 8. Absence is what makes it
 * a board he can act on in ten seconds at 7am. `judgeTerritory` returns `null`, and `buildExceptions`
 * drops it — there is no "ok" row anywhere in this module.
 *
 * ## Nothing here acts, and nothing here judges his honesty
 *
 * Every kind is about WORK NOT DONE — a seat with no rep, a plan not sent, a day with no visit. None
 * of it comes from `phoenix_crm_location_integrity`, none of it is a verdict on whether a visit was
 * real, and none of it reaches the rep. Golden Rule #1's blind half is about the rep's own screen;
 * this is a manager's screen and it is deliberately made of facts the rep can see about himself too.
 *
 * ## The suppression ladder
 *
 * Kinds are not independent. A vacant seat has nobody to plan, nobody to visit and nobody to fall
 * below a rate, so reporting five kinds against it would bury the one that matters. Each rung below
 * silences every rung under it, and the board carries ONE kind per territory: the worst true one.
 */

import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";

/**
 * Worst first, and this order IS the ranking — the board sorts by the index in this list, so moving a
 * line moves the board. Each entry's `why` is what the manager reads under the label; it says what to
 * do, never how bad it is.
 */
export const EXCEPTION_KINDS = [
  { key: "vacant", label: "No rep in this seat", why: "Nobody is working this territory." },
  { key: "never_opened", label: "Has never started", why: "Nothing on the carried-over list has been touched yet." },
  { key: "list_not_ready", label: "List still unfinished", why: "The carried-over list has been open more than 30 days." },
  { key: "plan_missing", label: "No plan this week", why: "This week has no plan at all." },
  { key: "plan_unsent", label: "Plan not sent", why: "The week is planned but has not gone for review." },
  { key: "no_visit", label: "No visit on the last field day", why: "The last full field day has no visit on it." },
  { key: "below_pm_rate", label: "Below the PM call rate", why: "PM calls a day are under the standard." },
  { key: "below_am_rate", label: "Below the AM call rate", why: "AM calls a day are under the standard." },
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]["key"];

const RANK = new Map<ExceptionKind, number>(EXCEPTION_KINDS.map((entry, index) => [entry.key, index]));

export function exceptionLabel(kind: ExceptionKind): string {
  return EXCEPTION_KINDS.find((entry) => entry.key === kind)?.label ?? kind;
}

export function exceptionWhy(kind: ExceptionKind): string {
  return EXCEPTION_KINDS.find((entry) => entry.key === kind)?.why ?? "";
}

/** The carried-over list is allowed to take a month before it is anybody's problem. */
export const LIST_GRACE_DAYS = 30;

/**
 * The call rate is read over a rolling window of FIELD days, never one day.
 *
 * One bad day is a doctor who cancelled; six is a pattern. The digest (B1) looks at the single
 * previous day, deliberately — a manager reading it at 06:55 wants yesterday — and this board, which
 * he opens when he has a minute, looks at the trend. Two windows on purpose, not a disagreement.
 */
export const RATE_WINDOW_FIELD_DAYS = 6;

/**
 * 🔴 `no_visit` is the one kind about a single DAY, and it only ever speaks about a day that has
 * ENDED.
 *
 * The plan called this "a Friday suppresses the day kinds", and that was the blunt version of it. The
 * noise it was aiming at is a board saying "no visit" at 10am about a day the rep is still working —
 * which happens every single morning, not only on Fridays. Reading the last day that FINISHED fixes
 * that, and it leaves the board useful on a Friday, which is when a manager most often has a minute
 * to look back at the week. The caller resolves which day that is; this module only names the rule.
 */
export const DAY_KINDS: ReadonlyArray<ExceptionKind> = ["no_visit"];

/** Saturday…Wednesday are full field days; Thursday is a half day; Friday is off. */
export function isFieldDay(isoDay: string): boolean {
  return weekdayOfIsoDay(isoDay) !== 5;
}

/**
 * The previous field day that has ENDED — never today, whatever day of the week today is.
 *
 * Today is excluded even when today is a field day: the rep has hours left to work it, and a board
 * that says "no visit" about a morning is a board a manager learns to ignore.
 */
export function lastFinishedFieldDay(cairoToday: string): string {
  const date = new Date(`${cairoToday}T00:00:00Z`);
  for (let back = 0; back < 10; back += 1) {
    date.setUTCDate(date.getUTCDate() - 1);
    const day = date.toISOString().slice(0, 10);
    if (isFieldDay(day)) return day;
  }
  // Unreachable — Friday is the only off day, so at most two steps back is always a field day.
  return cairoToday;
}

export type ExceptionRules = {
  callRateAmTarget: number;
  callRatePmTarget: number;
  /** Cairo today, so the list grace can be measured against the line's opening date. */
  cairoToday: string;
};

export type TerritoryFacts = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  /** Null when the seat is vacant — the board says so rather than printing an empty name. */
  repName: string | null;
  hasRep: boolean;
  /** When this territory's line opened in Phoenix CRM, for the list grace. Null = not dated. */
  lineOpenedOn: string | null;
  /** Real readiness for the carried-over list, or null when it could not be measured. */
  readiness: { total: number; validated: number; dropped: number; dropPending: number; ready: boolean } | null;
  /** This field week's plan, or null when the week has no plan header at all. */
  planStatus: "draft" | "submitted" | "approved" | "returned" | null;
  /** How many customers that plan holds. A header with no items is not a plan. */
  planItems: number;
  /** Field days in the rolling window that have finished. Zero disables both rate kinds. */
  windowFieldDays: number;
  windowAmVisits: number;
  windowPmVisits: number;
  /** Visits on `lastFinishedFieldDay`, AM and PM together — this one kind only asks "anything?". */
  lastFieldDayVisits: number;
};

export type TerritoryException = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  repName: string | null;
  kind: ExceptionKind;
  label: string;
  why: string;
  /** The figure behind it, already worded — "3 of 12 validated", "1.4 a day against 10". */
  detail: string | null;
};

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86400000);
}

function rate(visits: number, days: number): number {
  return days <= 0 ? 0 : visits / days;
}

function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * The worst true thing about one territory, or null when there is nothing to say.
 *
 * The ladder is top-down and stops at the first hit, which is what keeps one territory to one row:
 * a vacant seat is not also "no plan", because there is nobody to have made one.
 */
export function judgeTerritory(facts: TerritoryFacts, rules: ExceptionRules): TerritoryException | null {
  const base = {
    seatId: facts.seatId,
    territoryName: facts.territoryName,
    lineName: facts.lineName,
    repName: facts.repName,
  };
  const of = (kind: ExceptionKind, detail: string | null): TerritoryException => ({
    ...base,
    kind,
    label: exceptionLabel(kind),
    why: exceptionWhy(kind),
    detail,
  });

  if (!facts.hasRep) return of("vacant", null);

  const list = facts.readiness;
  if (list && list.total > 0) {
    // "Never started" is not "no visit yet" — it is that NOTHING on the carried-over list has been
    // touched: not one customer validated, not one dropped, not one drop even asked for. A rep who
    // has validated three of twelve has started and is simply behind, which is the next rung down.
    const touched = list.validated + list.dropped + list.dropPending;
    if (touched === 0) return of("never_opened", `${list.total} carried over, none touched`);
    if (!list.ready) {
      const since = facts.lineOpenedOn ? daysBetween(facts.lineOpenedOn, rules.cairoToday) : null;
      // Undated lines get the grace forever rather than an accusation the board cannot justify.
      if (since !== null && since > LIST_GRACE_DAYS) {
        return of("list_not_ready", `${list.validated} of ${list.total} done, ${since} days open`);
      }
    }
  }

  if (facts.planStatus === null || facts.planItems === 0) return of("plan_missing", null);
  if (facts.planStatus === "draft" || facts.planStatus === "returned") {
    return of("plan_unsent", facts.planStatus === "returned" ? "Returned, not sent again" : "Still a draft");
  }

  if (facts.lastFieldDayVisits === 0) return of("no_visit", null);

  // AM and PM are judged APART and never averaged (the call-rate golden rule). PM leads because a
  // doctor list is the bigger half of the day; only ONE of the two is ever shown, so a territory
  // under both reads as the PM one and the AM figure is not lost — it is simply not the headline.
  if (facts.windowFieldDays > 0) {
    const pm = rate(facts.windowPmVisits, facts.windowFieldDays);
    if (pm < rules.callRatePmTarget) {
      return of("below_pm_rate", `${oneDecimal(pm)} a day against ${rules.callRatePmTarget}`);
    }
    const am = rate(facts.windowAmVisits, facts.windowFieldDays);
    if (am < rules.callRateAmTarget) {
      return of("below_am_rate", `${oneDecimal(am)} a day against ${rules.callRateAmTarget}`);
    }
  }

  return null;
}

export type ExceptionsSummary = {
  territories: number;
  needingAttention: number;
  byKind: Array<{ kind: ExceptionKind; label: string; count: number }>;
};

export type ExceptionsBoard = {
  rows: TerritoryException[];
  summary: ExceptionsSummary;
};

/**
 * The board: every territory judged, the clean ones dropped, the rest worst first.
 *
 * Within one kind the order is the territory's own name, so the list is stable between two refreshes
 * — a manager reading down it must not have it reshuffle under him because a visit landed.
 */
export function buildExceptions(facts: ReadonlyArray<TerritoryFacts>, rules: ExceptionRules): ExceptionsBoard {
  const rows = facts
    .map((entry) => judgeTerritory(entry, rules))
    .filter((row): row is TerritoryException => row !== null)
    .sort(
      (left, right) =>
        (RANK.get(left.kind) ?? 99) - (RANK.get(right.kind) ?? 99) || left.territoryName.localeCompare(right.territoryName),
    );

  const counts = new Map<ExceptionKind, number>();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);

  return {
    rows,
    summary: {
      territories: facts.length,
      needingAttention: rows.length,
      // Only the kinds that actually occurred, in the same worst-first order — a chip reading zero is
      // the same noise as a green row, one line further up the screen.
      byKind: EXCEPTION_KINDS.flatMap((entry) =>
        counts.has(entry.key) ? [{ kind: entry.key, label: entry.label, count: counts.get(entry.key) as number }] : [],
      ),
    },
  };
}

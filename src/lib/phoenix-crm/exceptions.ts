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

import { isCallRateWorkingDay, type CallRateHolidays } from "@/lib/crm/call-rate";

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
  { key: "no_visit", label: "No visit on the last working day", why: "The last working day has no visit on it." },
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
 * The call rate is read over a rolling window of WORKING days, never one day.
 *
 * One bad day is a doctor who cancelled; six is a pattern. The digest (B1) looks at the single
 * previous day, deliberately — a manager reading it at 06:55 wants yesterday — and this board, which
 * he opens when he has a minute, looks at the trend. Two windows on purpose, not a disagreement.
 */
export const RATE_WINDOW_WORKING_DAYS = 6;

/**
 * 🔴 `no_visit` is the one kind about a single DAY, and it only ever speaks about a day that has
 * ENDED.
 *
 * The plan called this "a Friday suppresses the day kinds", and that was the blunt version of it. The
 * noise it was aiming at is a board saying "no visit" at 10am about a day the rep is still working —
 * which happens every single morning, not only on Fridays. Reading the last day that FINISHED fixes
 * that, and it leaves the board useful on a Friday, which is when a manager most often has a minute
 * to look back at the week. The caller resolves which day that is; this module only names the rule.
 *
 * 🔴 AND THE DAY IT SPEAKS ABOUT IS A WORKING DAY — Saturday to Wednesday, holidays out
 * ({@link lastFinishedWorkingDay}). A Thursday or a public holiday holds no obligation, so there is
 * nothing on it to be missing.
 */
export const DAY_KINDS: ReadonlyArray<ExceptionKind> = ["no_visit"];

/**
 * 🔴 A WORKING DAY IS SATURDAY TO WEDNESDAY, MINUS THE NATIONAL HOLIDAYS — the owner's own call-rate
 * rule, and this board reads no other one.
 *
 * It used to exclude FRIDAY ALONE, which put Thursdays and public holidays into both halves of the
 * call rate: the owner excluded Thursday outright on 2026-09-05 ("donot count thursday as working
 * day") and took national holidays out of the denominator on 2026-09-02 ("if we have a national
 * vacation in this week, then the week will be four"). With Thursday counted, a rep who had made
 * exactly 10 PM calls on each of Saturday to Wednesday read 50 / 6 = 8.3 and was listed "Below the
 * PM call rate" — a perfect week, reported as a failure, by the calendar rather than by the rep. A
 * holiday Thursday such as 8 October 2026 (Armed Forces Day, moved) did it twice over.
 *
 * `isCallRateWorkingDay` is that rule, imported and never re-derived: the denominator on Reps List
 * and the KPIs board is the same function, so this board can no longer disagree with them about
 * which days a rep owed work on. `holidays` is optional only so the pure weekday half can be tested
 * on its own; every caller on a real board passes the loaded set.
 */
export function isWorkingDay(isoDay: string, holidays?: CallRateHolidays): boolean {
  return isCallRateWorkingDay(isoDay, holidays);
}

/**
 * The previous WORKING day that has ENDED — never today, whatever day of the week today is.
 *
 * Today is excluded even when today is a working day: the rep has hours left to work it, and a board
 * that says "no visit" about a morning is a board a manager learns to ignore.
 *
 * 🔴 NULL WHEN THERE IS NO SUCH DAY INSIDE A MONTH, AND A NULL IS NOT A DAY. With holidays out, a
 * long Eid plus the weekend can put several days between today and the last day anybody owed work
 * on; a fallback to `cairoToday` would have the board judging a day that has not finished, which is
 * the exact noise this function exists to remove. Every caller must read the null as "there is
 * nothing to judge yet" — never as a date.
 */
export function lastFinishedWorkingDay(cairoToday: string, holidays?: CallRateHolidays): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cairoToday)) return null;
  const date = new Date(`${cairoToday}T00:00:00Z`);
  for (let back = 0; back < 31; back += 1) {
    date.setUTCDate(date.getUTCDate() - 1);
    const day = date.toISOString().slice(0, 10);
    if (isWorkingDay(day, holidays)) return day;
  }
  return null;
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
  /**
   * The STANDING one-day return on that plan (`standingReturnedDay`), or null.
   *
   * 🔴 A WEEK RETURNED FOR ONE DAY IS STILL SENT ON EVERY OTHER DAY (owner, 2026-10-02, "Still
   * planned"), so it is NOT "Plan not sent". Reading the week's bare `returned` status listed such a
   * territory as unsent while the rep's own visits on its other days were counting as planned — the
   * board contradicting the stamp the database had already put on his work.
   */
  planReturnedDay: string | null;
  /** How many customers that plan holds. A header with no items is not a plan. */
  planItems: number;
  /** Working days in the rolling window that have finished. Zero disables both rate kinds. */
  windowWorkingDays: number;
  windowAmVisits: number;
  windowPmVisits: number;
  /**
   * Visits on `lastFinishedWorkingDay`, AM and PM together — this one kind only asks "anything?".
   * NULL when there was no finished working day to ask about, which suppresses the kind rather than
   * reading as a zero.
   */
  lastWorkingDayVisits: number | null;
  /**
   * 🔴 APPROVED LEAVE IS A DAY NOBODY OWED WORK ON, EXACTLY LIKE A HOLIDAY — and until 2026-10-03
   * this board could not see it at all.
   *
   * The owner found it on Delta (1)'s go-live morning: the board listed a rep as missing her plan
   * while she was on sick leave, which is a manager being told to chase someone who is signed off.
   * His ruling was *"Show 'On leave', not an exception"*, so leave now does two separate things —
   * it comes OUT of the call-rate denominator the way `isCallRateWorkingDay` takes holidays out,
   * and a territory whose rep is away reads as a state rather than a failure.
   *
   * 🔴 FULL DAYS ONLY, AND THE HALF DAY IS A DELIBERATE GAP, NOT AN OVERSIGHT. `ApprovedLeaveDay`
   * reduces the stored `day_part` (`full_day` / `am_only` / `pm_only`) to a bare `fullDay` boolean,
   * so by the time leave reaches a reader it no longer says WHICH half was taken — and that type has
   * fourteen consumers across attendance, the CEO command centre and compliance, so widening it is
   * not this fix's business. A half day therefore changes nothing here: the rep owed the other half,
   * and guessing which one would either excuse work that was owed or accuse work that was not. The
   * conservative direction is the one that never silently forgives a missed day.
   */
  leaveFullDaysInWindow: number;
  /** True only when the rep had a FULL day of approved leave on `lastFinishedWorkingDay`. */
  leaveOnLastWorkingDay: boolean;
  /**
   * True only when approved leave covers EVERY working day of this field week. A week signed off in
   * full has no plan to make; leave on two days of five does not excuse the plan for the other three.
   */
  leaveCoversWholeWeek: boolean;
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

/**
 * A territory whose rep is away: on the board, but not an exception.
 *
 * It is a separate list rather than a ninth {@link EXCEPTION_KINDS} entry on purpose. Everything in
 * `EXCEPTION_KINDS` is counted into `needingAttention` and sorted into the worst-first ladder, and
 * being on approved leave is neither — it needs no action from the manager. Keeping it visible is
 * the other half of the owner's ruling: a territory nobody is covering this week is worth SEEING,
 * so hiding the row would trade one blind spot for another.
 */
export const ON_LEAVE_LABEL = "On leave";

export type TerritoryOnLeave = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  repName: string | null;
  label: typeof ON_LEAVE_LABEL;
  /** What the leave covers, already worded — "all week", "the last working day". */
  detail: string;
};

/** Whole-week leave is the only shape that takes a territory off the exception ladder entirely. */
function onLeaveAllWeek(facts: TerritoryFacts): boolean {
  return facts.hasRep && facts.leaveCoversWholeWeek;
}

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

  // 🔴 A WEEK SIGNED OFF IN FULL HAS NOTHING TO ACCUSE. It is not "no plan this week" — there was no
  // week to plan — so the territory leaves the ladder entirely and `buildExceptions` lists it as
  // ON LEAVE instead. Part-week leave deliberately falls through: two days off does not excuse the
  // plan for the other three, it only takes those two days out of the rate below.
  if (onLeaveAllWeek(facts)) return null;

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
  // 🔴 A week returned for ONE day is still sent on its other days, so it is not unsent (owner,
  // 2026-10-02). Only a draft, or a week returned WHOLE, has never gone for review.
  if (facts.planStatus === "draft" || (facts.planStatus === "returned" && facts.planReturnedDay === null)) {
    return of("plan_unsent", facts.planStatus === "returned" ? "Returned, not sent again" : "Still a draft");
  }

  // 🔴 ONLY A FULL DAY OF LEAVE ANSWERS "anything?" — a rep on half a day still worked the other
  // half, so a day with no visit at all is still a day with no visit.
  if (facts.lastWorkingDayVisits === 0 && !facts.leaveOnLastWorkingDay) return of("no_visit", null);

  // AM and PM are judged APART and never averaged (the call-rate golden rule). PM leads because a
  // doctor list is the bigger half of the day; only ONE of the two is ever shown, so a territory
  // under both reads as the PM one and the AM figure is not lost — it is simply not the headline.
  //
  // 🔴 AND APPROVED LEAVE COMES OUT OF THE DENOMINATOR, EXACTLY AS A HOLIDAY DOES. Six working days
  // with two full days of approved leave is a four-day week for that rep; dividing his real calls by
  // six reports a rep who worked every day he owed as "below the rate" — the same defect the Thursday
  // fix removed, arriving through leave instead of the calendar. Both halves share one figure because
  // only FULL days are known (see `leaveFullDaysInWindow`), and both are still judged APART.
  const owedDays = Math.max(0, facts.windowWorkingDays - facts.leaveFullDaysInWindow);
  if (owedDays > 0) {
    const pm = rate(facts.windowPmVisits, owedDays);
    if (pm < rules.callRatePmTarget) {
      return of("below_pm_rate", `${oneDecimal(pm)} a day against ${rules.callRatePmTarget}`);
    }
    const am = rate(facts.windowAmVisits, owedDays);
    if (am < rules.callRateAmTarget) {
      return of("below_am_rate", `${oneDecimal(am)} a day against ${rules.callRateAmTarget}`);
    }
  }

  return null;
}

export type ExceptionsSummary = {
  territories: number;
  needingAttention: number;
  /**
   * Territories whose rep is away all week. Counted separately and NEVER folded into
   * `needingAttention` — that figure is what the 06:55 digest sends and what a manager acts on, so
   * an on-leave rep inside it is a chase nobody owes.
   */
  onLeave: number;
  byKind: Array<{ kind: ExceptionKind; label: string; count: number }>;
};

export type ExceptionsBoard = {
  rows: TerritoryException[];
  /** Visible, but not a failure — the owner's "Show 'On leave', not an exception". */
  onLeave: TerritoryOnLeave[];
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

  // Same name order as the ladder, for the same reason: the list must not reshuffle under a manager
  // reading down it.
  const onLeave: TerritoryOnLeave[] = facts
    .filter((entry) => onLeaveAllWeek(entry))
    // The return annotation is what keeps `label` at its literal type — without it the object
    // literal widens to `string` and the board's own label can drift from ON_LEAVE_LABEL.
    .map((entry): TerritoryOnLeave => ({
      seatId: entry.seatId,
      territoryName: entry.territoryName,
      lineName: entry.lineName,
      repName: entry.repName,
      label: ON_LEAVE_LABEL,
      detail: "Approved leave all week",
    }))
    .sort((left, right) => left.territoryName.localeCompare(right.territoryName));

  return {
    rows,
    onLeave,
    summary: {
      territories: facts.length,
      needingAttention: rows.length,
      onLeave: onLeave.length,
      // Only the kinds that actually occurred, in the same worst-first order — a chip reading zero is
      // the same noise as a green row, one line further up the screen.
      byKind: EXCEPTION_KINDS.flatMap((entry) =>
        counts.has(entry.key) ? [{ kind: entry.key, label: entry.label, count: counts.get(entry.key) as number }] : [],
      ),
    },
  };
}

/**
 * Phoenix CRM — grade against capacity: what a territory's LIST asks of a month, against what the
 * month's field days can hold. No I/O.
 *
 * Owner, 2026-10-02, one of the five reports he picked that day: per territory, the visits a month its
 * list requires by grade, against what the month's field days allow. Measured on production the day
 * it was asked for, over October 2026 — 21 PM days, so 210 PM visits at ten a day: 68 of 72
 * territories need more PM visits than ten a day can hold, 4 need more than even fifteen a day allows,
 * the median need is 264, and grade A is anywhere from 6% to 96% of a territory's PM list. This board
 * puts that on one screen, territory by territory.
 *
 * ## 🔴 LIST SIZE AGAINST CAPACITY — NOT ACHIEVED COVERAGE
 *
 * The plan review's coverage counts VALIDATED customers only (owner, 2026-10-01: a customer is planned
 * and visited before validation and counted after it). This board asks a different question — is the
 * list the right size for the month — and on the day it shipped nearly every customer was still
 * carried over from iReports360 and not validated. So a customer not validated yet counts here with
 * the grade iReports360 carried over, and the board SAYS so (`notValidated`), because a reader who
 * took this for coverage would be reading the wrong number.
 *
 * ## 🔴 EVERY NUMBER IS READ, NEVER TYPED
 *
 * The grade's monthly visits are `grade_targets` from Phoenix CRM's own settings; the per-day target is
 * the call rate (AM against 2, PM against 10 — the locked standard `PHOENIX_CRM_DEFAULT_SETTINGS`
 * carries); the per-day cap is the plan cap (`pm_daily_cap`, `am_daily_cap` — 15 and 5 today). Nothing
 * in this file names any of them as a number, so a change in Settings is a change on the board.
 *
 * ## 🔴 THE DAYS ARE THE PLAN'S OWN
 *
 * `planDayListTypes` — Thursday is a morning and holds AM only, Friday holds nothing — and a public
 * holiday from the confirmed national calendar (the same reader the plan greys days with,
 * `server/plan-holidays.ts`) comes out of both halves. AM and PM are counted APART, always: there is no
 * combined need, no combined capacity and no combined verdict anywhere on this board.
 *
 * ## It only SHOWS
 *
 * A grade change stays the district manager's own decision on the List (owner, 2026-09-23 and
 * 2026-09-29). Nothing here proposes one, and nothing here judges the rep: the list is the territory's,
 * and its size is the manager's and SFE's question.
 */

import { planDayListTypes } from "@/lib/phoenix-crm/calendar";
import { gradeTarget, sharePercent } from "@/lib/phoenix-crm/coverage";
import { monthDays } from "@/lib/phoenix-crm/team-calendar";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

export type CapacitySettings = Pick<PhoenixCrmSettings, "gradeTargets" | "pmDailyCap" | "amDailyCap" | "callRatePmTarget" | "callRateAmTarget">;

const GRADES: readonly PhoenixCrmGrade[] = ["A", "B", "C"];

// ── The month ───────────────────────────────────────────────────────────────────────────────────

export type CapacityMonth = { month: string; monthStart: string; monthEnd: string };

export type CapacityMonthResult = { ok: true; value: CapacityMonth } | { ok: false; error: string };

function nextMonthKey(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
}

/**
 * The months this board reads: this month, or the next one — the month a plan is being built for.
 *
 * A past month is refused rather than read: the list on the board is the list as it stands TODAY, and
 * laying today's list over last month's days would print a capacity that never existed.
 */
export function capacityMonthsOffered(cairoToday: string): string[] {
  const current = cairoToday.slice(0, 7);
  return [current, nextMonthKey(current)];
}

export function resolveCapacityMonth(input: { month: unknown; cairoToday: string }): CapacityMonthResult {
  const offered = capacityMonthsOffered(input.cairoToday);
  const raw = input.month === undefined || input.month === null || input.month === "" ? offered[0] : input.month;
  if (typeof raw !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return { ok: false, error: "Choose a valid month." };
  if (!offered.includes(raw)) return { ok: false, error: "This board reads this month or the next one." };
  const days = monthDays(raw);
  return { ok: true, value: { month: raw, monthStart: days[0] as string, monthEnd: days[days.length - 1] as string } };
}

export type FieldDays = {
  /** Days a plan can hold AM on: every field day, Thursday's morning included. */
  AM: number;
  /** Days a plan can hold PM on: Saturday to Wednesday. */
  PM: number;
  /** The public holidays that took a field day out, with their names. A holiday on a Friday took nothing. */
  holidays: Array<{ day: string; name: string }>;
};

/** A month's field days, AM and PM apart: the plan's own week, less the public holidays. */
export function monthFieldDays(month: string, holidays: ReadonlyMap<string, string>): FieldDays {
  let am = 0;
  let pm = 0;
  const removed: FieldDays["holidays"] = [];
  for (const day of monthDays(month)) {
    const holds = planDayListTypes(day);
    if (holds.length === 0) continue;
    const holiday = holidays.get(day);
    if (holiday !== undefined) {
      removed.push({ day, name: holiday });
      continue;
    }
    if (holds.includes("AM")) am += 1;
    if (holds.includes("PM")) pm += 1;
  }
  return { AM: am, PM: pm, holidays: removed };
}

/** The per-day figures a list type is read against: the call rate, and the plan's own cap. */
export function perDayFigures(settings: CapacitySettings, listType: PhoenixCrmListType): { target: number; cap: number } {
  return listType === "PM"
    ? { target: settings.callRatePmTarget, cap: settings.pmDailyCap }
    : { target: settings.callRateAmTarget, cap: settings.amDailyCap };
}

// ── What the list asks for ──────────────────────────────────────────────────────────────────────

export type CapacityCustomer = {
  listType: PhoenixCrmListType;
  /** The grade on the list — for a customer not validated yet, the grade iReports360 carried over. */
  grade: PhoenixCrmGrade | null;
  validated: boolean;
};

export type ListNeed = {
  /** Customers on the list: validated, and carried over waiting to be. */
  customers: number;
  validated: number;
  /** Counted with the grade iReports360 carried over, because nobody has validated them yet. */
  notValidated: number;
  grades: Record<PhoenixCrmGrade, number>;
  /** No grade at all, so no monthly number. */
  noGrade: number;
  /** A grade whose list type sets no monthly number in Settings (AM B and C today): on the list, asking nothing. */
  noNumber: number;
  /** The visits a month the grades ask for. */
  required: number;
  /** Grade A's share of the list, 0–100 with one decimal; null with an empty list. */
  gradeAShare: number | null;
};

export function listNeed(customers: ReadonlyArray<CapacityCustomer>, listType: PhoenixCrmListType, settings: CapacitySettings): ListNeed {
  const grades: Record<PhoenixCrmGrade, number> = { A: 0, B: 0, C: 0 };
  let count = 0;
  let validated = 0;
  let noGrade = 0;
  let noNumber = 0;
  let required = 0;
  for (const customer of customers) {
    if (customer.listType !== listType) continue;
    count += 1;
    if (customer.validated) validated += 1;
    if (!customer.grade || !GRADES.includes(customer.grade)) {
      noGrade += 1;
      continue;
    }
    grades[customer.grade] += 1;
    const visits = gradeTarget(settings, listType, customer.grade);
    if (visits === null) noNumber += 1;
    else required += visits;
  }
  return {
    customers: count,
    validated,
    notValidated: count - validated,
    grades,
    noGrade,
    noNumber,
    required,
    gradeAShare: sharePercent(grades.A, count),
  };
}

/**
 *   no_list      nobody on this list
 *   no_days      the month holds no day for this list (never, in practice — but never a divide by zero)
 *   fits         the per-day target holds the month's visits
 *   over_target  it takes more than the per-day target, and the plan cap still holds it
 *   over_cap     even the plan cap, every field day of the month, cannot hold it
 */
export type CapacityVerdict = "no_list" | "no_days" | "fits" | "over_target" | "over_cap";

export type ListCapacity = ListNeed & {
  days: number;
  perDayTarget: number;
  perDayCap: number;
  /** The month at the per-day target: days × target. */
  atTarget: number;
  /** The month at the plan cap: days × cap. */
  atCap: number;
  /** The visits a day the list needs, one decimal; null when the month holds no day for it. */
  perDayNeeded: number | null;
  /** Visits beyond what the per-day target holds; 0 when it fits. */
  beyondTarget: number;
  /** Visits beyond even the cap; 0 when the cap holds them. */
  beyondCap: number;
  verdict: CapacityVerdict;
};

export function listCapacity(need: ListNeed, days: number, perDay: { target: number; cap: number }): ListCapacity {
  const atTarget = days * perDay.target;
  const atCap = days * perDay.cap;
  const verdict: CapacityVerdict =
    need.customers === 0 ? "no_list" : days <= 0 ? "no_days" : need.required > atCap ? "over_cap" : need.required > atTarget ? "over_target" : "fits";
  return {
    ...need,
    days,
    perDayTarget: perDay.target,
    perDayCap: perDay.cap,
    atTarget,
    atCap,
    perDayNeeded: days > 0 ? Math.round((need.required / days) * 10) / 10 : null,
    beyondTarget: Math.max(0, need.required - atTarget),
    beyondCap: Math.max(0, need.required - atCap),
    verdict,
  };
}

/**
 * The verdict in a few words — "PM over 15 a day", "PM over 10 a day", "PM fits 10 a day" — the one
 * wording the screen's pill and the workbook's column both print. It is about the LIST's size against
 * the month, never about the rep: he does not choose who is on his list.
 */
export function capacityVerdictText(capacity: Pick<ListCapacity, "verdict" | "perDayTarget" | "perDayCap">, listType: PhoenixCrmListType): string {
  if (capacity.verdict === "no_list") return `No ${listType} list`;
  if (capacity.verdict === "no_days") return `No ${listType} day`;
  if (capacity.verdict === "over_cap") return `${listType} over ${capacity.perDayCap} a day`;
  if (capacity.verdict === "over_target") return `${listType} over ${capacity.perDayTarget} a day`;
  return `${listType} fits ${capacity.perDayTarget} a day`;
}

/** "PM A 3 · B 2 · C 1" — the grade numbers Settings holds, as the board used them. */
export function gradeTargetsText(targets: CapacitySettings["gradeTargets"], listType: PhoenixCrmDoctorListType): string {
  const parts = GRADES.map((grade) => {
    const value = targets[listType][grade];
    return `${grade} ${value === null ? "no number" : value}`;
  });
  return `${listType} ${parts.join(" · ")}`;
}

// ── The board ───────────────────────────────────────────────────────────────────────────────────

export type CapacityTerritoryInput = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  repName: string | null;
  customers: ReadonlyArray<CapacityCustomer>;
  /**
   * Where the list was read from. `phoenix`: the territory's own list in Phoenix CRM. `reference`: the
   * territory's list has not been opened in Phoenix yet, so it is read straight from what iReports360
   * holds — the same rows Phoenix carries over the first time the list is opened.
   */
  listSource: "phoenix" | "reference";
};

export type CapacityRow = Omit<CapacityTerritoryInput, "customers"> & { am: ListCapacity; pm: ListCapacity };

export type CapacitySummary = {
  territories: number;
  /** Territories with anyone on either list. */
  withList: number;
  pmOverTarget: number;
  pmOverCap: number;
  amOverTarget: number;
  amOverCap: number;
  /** The middle territory's need, over the territories with a list of that type; null with none. */
  pmMedianRequired: number | null;
  amMedianRequired: number | null;
  /** Grade A's share of a PM list, lowest and highest across the territories that have one. */
  pmGradeAShare: { min: number; max: number } | null;
  /** Customers counted with a carried-over grade, AM and PM apart. */
  notValidated: { AM: number; PM: number };
};

const SEVERITY: Record<CapacityVerdict, number> = { over_cap: 4, over_target: 3, fits: 2, no_days: 1, no_list: 0 };

/** The middle value, interpolated between the two middles of an even count (as Postgres' percentile_cont(0.5)). */
export function medianOf(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(value * 10) / 10;
}

function isOver(capacity: ListCapacity): boolean {
  return capacity.verdict === "over_target" || capacity.verdict === "over_cap";
}

/**
 * One row per territory, the tightest first: PM over the cap, then PM over the target, each by how
 * many visits a day it needs; AM after PM; the territory's name last, so the order never reshuffles
 * between two refreshes. Every territory stays on the board, an empty list included — a gap shows
 * instead of vanishing.
 */
export function buildCapacityBoard(
  territories: ReadonlyArray<CapacityTerritoryInput>,
  fieldDays: Pick<FieldDays, "AM" | "PM">,
  settings: CapacitySettings,
): { rows: CapacityRow[]; summary: CapacitySummary } {
  const amPerDay = perDayFigures(settings, "AM");
  const pmPerDay = perDayFigures(settings, "PM");
  const rows: CapacityRow[] = territories.map(({ customers, ...territory }) => ({
    ...territory,
    am: listCapacity(listNeed(customers, "AM", settings), fieldDays.AM, amPerDay),
    pm: listCapacity(listNeed(customers, "PM", settings), fieldDays.PM, pmPerDay),
  }));

  rows.sort(
    (left, right) =>
      SEVERITY[right.pm.verdict] - SEVERITY[left.pm.verdict] ||
      (right.pm.perDayNeeded ?? -1) - (left.pm.perDayNeeded ?? -1) ||
      SEVERITY[right.am.verdict] - SEVERITY[left.am.verdict] ||
      (right.am.perDayNeeded ?? -1) - (left.am.perDayNeeded ?? -1) ||
      left.territoryName.localeCompare(right.territoryName),
  );

  const pmLists = rows.filter((row) => row.pm.customers > 0);
  const amLists = rows.filter((row) => row.am.customers > 0);
  const shares = pmLists.map((row) => row.pm.gradeAShare).filter((share): share is number => share !== null);
  return {
    rows,
    summary: {
      territories: rows.length,
      withList: rows.filter((row) => row.am.customers > 0 || row.pm.customers > 0).length,
      pmOverTarget: rows.filter((row) => isOver(row.pm)).length,
      pmOverCap: rows.filter((row) => row.pm.verdict === "over_cap").length,
      amOverTarget: rows.filter((row) => isOver(row.am)).length,
      amOverCap: rows.filter((row) => row.am.verdict === "over_cap").length,
      pmMedianRequired: medianOf(pmLists.map((row) => row.pm.required)),
      amMedianRequired: medianOf(amLists.map((row) => row.am.required)),
      pmGradeAShare: shares.length > 0 ? { min: Math.min(...shares), max: Math.max(...shares) } : null,
      notValidated: {
        AM: rows.reduce((sum, row) => sum + row.am.notValidated, 0),
        PM: rows.reduce((sum, row) => sum + row.pm.notValidated, 0),
      },
    },
  };
}

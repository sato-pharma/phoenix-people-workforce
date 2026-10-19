// Plan office-day resolution — the PURE half of plan-office-days.ts. No DB, no I/O, so the two
// owner rulings it carries are pinned on plain values (tests/attendance-reconcile-day.test.ts).
//
// 1. THE APPROVED WEEKLY PLAN GOVERNS THE DAY; THE MONTHLY PLAN IS SHOWN BESIDE IT (owner,
//    2026-10-19: "show both", and attendance follows the approved weekly plan). The weekly plan is
//    approved later and is the more specific of the two, and the planning module already says so —
//    an approved month cannot be rewritten, so "the weekly plan governs those days". Until this
//    ruling the office lookup merged both kinds by "any Office wins", so a monthly Office day
//    overrode a weekly Field day and the person was judged in the office on a day their governing
//    plan sent them out. A monthly plan still decides a date no weekly plan covers.
//
// 2. A HALF-DAY OFFICE PLAN IS HALF AN OFFICE DAY (owner, 2026-10-19). An Office morning (or
//    afternoon) beside a field half, or beside nothing for a Group Product Manager who plans one
//    half, expects the person in the office for THAT half only — the attendance engine then judges
//    the office half with the same half-day math an approved half-day vacation uses — in the
//    Employee Day-by-Day Report AND in the fingerprint report that produces the deductions (owner,
//    2026-10-19: "deductions follow it too").
//
// 3. ON A DAY WITH AN OFFICE HALF, A MEETING HALF COUNTS AS OFFICE TOO (owner, 2026-10-19:
//    "meetings count as office"). Office morning + "Meeting with Team" (or "Meeting") afternoon is a
//    FULL office day, judged on the full hours. A meeting alone never makes an office day: a day
//    with no Office entry stays exactly what it was.

import {
  halfDayEffectiveStartMinutes,
  requiredMinutesForHalfDayVacation,
  type FlexibleHoursConfig,
} from "@/lib/attendance/flexible-hours";
import type { PlanSlot } from "@/lib/weekly-planning/plan-v1";

/** Which plan a lookup entry came from. A Phoenix CRM manager week is a weekly plan. */
export type PlanOfficeSourceKind = "weekly" | "monthly";

/** One approved plan entry on one date. */
export type PlanOfficeEntry = {
  kind: PlanOfficeSourceKind;
  isOffice: boolean;
  /** A meeting half — office only on a day that already has an Office half (ruling 3). Absent = no. */
  isMeeting?: boolean;
  slot: PlanSlot;
};

/** The plan form's meeting activities (`PLAN_ACTIVITY_TYPES`) that count as office beside an Office half. */
export const PLAN_MEETING_ACTIVITY_TYPES: readonly string[] = ["Meeting", "Meeting with Team"];

export function isPlanMeetingActivity(activityType: string | null | undefined): boolean {
  return PLAN_MEETING_ACTIVITY_TYPES.includes(String(activityType ?? "").trim());
}

export type PlanOfficeDay = {
  /** What attendance follows: the governing plan has an Office entry on this date. */
  isOffice: boolean;
  /**
   * Set when the governing plan's Office entries, with any meeting half beside them, cover exactly
   * ONE half (no full-day entry and not both halves) — the day is then half an office day, and only
   * that half is judged.
   */
  officeHalf: "am" | "pm" | null;
  /** The plan kind attendance followed on this date. */
  followed: PlanOfficeSourceKind;
  /**
   * Set only when an approved monthly plan ALSO covers the date and DISAGREES with the weekly plan
   * attendance followed — so a screen can show both instead of hiding the monthly one.
   */
  monthlyDisagrees: { isOffice: boolean } | null;
};

// Called only for a day the governing plan already marks Office, so a meeting half can join it here.
function officeHalfOf(entries: readonly PlanOfficeEntry[]): "am" | "pm" | null {
  const officeSlots = new Set(entries.filter((entry) => entry.isOffice || entry.isMeeting).map((entry) => entry.slot));
  if (officeSlots.size === 0 || officeSlots.has("full")) return null;
  if (officeSlots.has("am") && officeSlots.has("pm")) return null;
  return officeSlots.has("am") ? "am" : "pm";
}

/** Resolve one date from every approved plan entry on it; null when no plan covers the date. */
export function resolvePlanOfficeDay(entries: readonly PlanOfficeEntry[]): PlanOfficeDay | null {
  if (entries.length === 0) return null;
  const weekly = entries.filter((entry) => entry.kind === "weekly");
  const monthly = entries.filter((entry) => entry.kind === "monthly");
  const followed: PlanOfficeSourceKind = weekly.length > 0 ? "weekly" : "monthly";
  const governing = followed === "weekly" ? weekly : monthly;
  const isOffice = governing.some((entry) => entry.isOffice);
  const monthlyIsOffice = monthly.some((entry) => entry.isOffice);
  return {
    isOffice,
    officeHalf: isOffice ? officeHalfOf(governing) : null,
    followed,
    monthlyDisagrees: followed === "weekly" && monthly.length > 0 && monthlyIsOffice !== isOffice
      ? { isOffice: monthlyIsOffice }
      : null,
  };
}

/**
 * The half-day part the attendance engine should judge the day with, in the engine's own words:
 * `am_only` / `pm_only` name the half that is COVERED (as an approved half-day vacation does), so an
 * Office MORNING leaves the afternoon covered — `pm_only` — and the morning is what gets judged.
 */
export function planOfficeCoveredPart(day: PlanOfficeDay | null | undefined): "am_only" | "pm_only" | null {
  if (!day?.isOffice || !day.officeHalf) return null;
  return day.officeHalf === "am" ? "pm_only" : "am_only";
}

/**
 * The half the FINGERPRINT REPORT — the engine that produces the attendance deductions — judges a
 * punch day with (owner, 2026-10-19: "deductions follow it too"). An approved half-day vacation keeps
 * its own half, so a day is never halved twice. Otherwise a half-Office plan day on an
 * office-days-only seat is judged on its office half; every other seat, and every full or field day,
 * is judged exactly as before.
 */
export function judgedHalfDayPart(input: {
  halfDayVacationPart: "am_only" | "pm_only" | null;
  judgmentMode: string | null | undefined;
  planDay: PlanOfficeDay | null | undefined;
}): "am_only" | "pm_only" | null {
  if (input.halfDayVacationPart) return input.halfDayVacationPart;
  return input.judgmentMode === "office_days_only" ? planOfficeCoveredPart(input.planDay) : null;
}

/**
 * The day's flexible-hours config for a half-day Office plan. `coveredPart` names the half that is
 * NOT office (planOfficeCoveredPart): the required presence halves, and when the morning is the
 * covered half the office afternoon is judged from where it begins — the same two moves an approved
 * half-day vacation makes (requiredMinutesForHalfDayVacation, halfDayEffectiveStartMinutes). The
 * flex window keeps its width. A full office day, or no plan, keeps the config untouched.
 */
export function officeHalfConfig(config: FlexibleHoursConfig, coveredPart: "am_only" | "pm_only" | null): FlexibleHoursConfig {
  if (!coveredPart) return config;
  const requiredMinutes = requiredMinutesForHalfDayVacation(config.requiredMinutes, coveredPart);
  const scheduledStartMinutes = halfDayEffectiveStartMinutes(config.scheduledStartMinutes, requiredMinutes, coveredPart);
  return {
    scheduledStartMinutes,
    flexCeilingMinutes: scheduledStartMinutes + (config.flexCeilingMinutes - config.scheduledStartMinutes),
    requiredMinutes,
  };
}

/**
 * The plan as a report cell: "Office", "Office (morning)", "Field", and — when the approved monthly
 * plan says otherwise — the monthly plan beside it, e.g. "Field (monthly plan: Office)". Empty when
 * no approved plan covers the date.
 */
export function planOfficeDayLabel(day: PlanOfficeDay | null | undefined): string {
  if (!day) return "";
  const base = day.isOffice
    ? day.officeHalf === "am" ? "Office (morning)" : day.officeHalf === "pm" ? "Office (afternoon)" : "Office"
    : "Field";
  return day.monthlyDisagrees ? `${base} (monthly plan: ${day.monthlyDisagrees.isOffice ? "Office" : "Field"})` : base;
}

/** A sentence for a day's reason text, or "" when the plan needs no explaining. */
export function planOfficeDayNote(day: PlanOfficeDay | null | undefined): string {
  if (!day) return "";
  const notes: string[] = [];
  if (day.isOffice && day.officeHalf) {
    notes.push(`Office for the ${day.officeHalf === "am" ? "morning" : "afternoon"} only — judged on that half.`);
  }
  if (day.monthlyDisagrees) {
    notes.push(
      `The approved weekly plan says ${day.isOffice ? "Office" : "Field"}; the monthly plan says ${day.monthlyDisagrees.isOffice ? "Office" : "Field"} — the weekly plan is followed.`,
    );
  }
  return notes.join(" ");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text regression guard (getVacationRequestPageData does a live DB read via
// getCurrentEmployee, which the Node unit-test harness can't easily exercise end-to-end without
// a Supabase fixture layer — matching this repo's own idiom for pinning fixes to DB-touching
// functions via source inspection). Two independent bugs, both in src/lib/vacation/service.ts:
//
// 1. getVacationRequestPageData's balanceReferenceDates used a plain server-clock "today" for
//    the compensatory/emergency/other/sick leave types, while the "annual" key one line above
//    already correctly used the Cairo-anchored getAnnualVacationMinimumStartDate() — an internal
//    inconsistency within one object literal. Fixed by routing "today" through the same
//    Cairo-aware primitive as everything else in this codebase.
// 2. addBusinessDays/businessDaysBetween's Fri/Sat (Egypt weekend) check read getUTCDay() on a
//    real timestamp — which can disagree with the Cairo weekday for the few hours before UTC
//    midnight where Cairo has already rolled to the next calendar day. Feeds
//    buildVacationSlaStatus's due-date/overdue flag.

function src(path: string): string {
  return readFileSync(path, "utf8");
}

// Re-implements the exact one-line Intl pattern the fixed cairoDayOfWeek uses (it's module-private
// in service.ts, not exported) to behaviorally verify the pattern itself is correct — the source-
// text assertions below confirm the actual function in service.ts uses this same pattern.
function cairoDayOfWeek(date: Date): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

export function runVacationCairoTodayTests() {
  // The exact scenario the fix addresses: a real timestamp late Thursday UTC is already Friday
  // (a weekend day in Egypt) once viewed through Cairo — getUTCDay() would wrongly say Thursday.
  const lateThursdayUtc = new Date("2026-07-23T22:30:00Z"); // Cairo 01:30 Fri (EEST, UTC+3)
  assert.equal(lateThursdayUtc.getUTCDay(), 4, "sanity: this instant is still Thursday in UTC");
  assert.equal(cairoDayOfWeek(lateThursdayUtc), 5, "but it is already Friday (weekend) in Cairo");

  const service = src("src/lib/vacation/service.ts");

  assert.match(
    service,
    /const today = currentCairoDateOnlyIso\(\);/,
    "getVacationRequestPageData's today must resolve via the Cairo-aware helper",
  );
  assert.doesNotMatch(
    service,
    /const today = toDateOnlyString\(new Date\(\)\)/,
    "getVacationRequestPageData's today must not resolve via the server's local/UTC clock",
  );
  // All four non-annual balance-reference keys, plus annual, must share one Cairo-consistent
  // "today" — not just some of the five.
  assert.match(
    service,
    /balanceReferenceDates: Record<VacationType, string> = \{\s*annual: getAnnualVacationMinimumStartDate\(\),\s*compensatory: today,\s*emergency: today,\s*other: today,\s*sick: today,/,
    "every balanceReferenceDates key must derive from a Cairo-consistent today",
  );

  assert.match(
    service,
    /function cairoDayOfWeek\(date: Date\): number \{/,
    "a Cairo-aware weekday resolver must exist for the Fri\\/Sat weekend check",
  );
  const addBusinessDaysBlock = service.match(/function addBusinessDays\(date: Date, days: number\) \{[\s\S]{0,300}?\n\}/)?.[0] ?? "";
  assert.match(addBusinessDaysBlock, /cairoDayOfWeek\(result\)/, "addBusinessDays must classify weekends via Cairo, not getUTCDay()");
  assert.doesNotMatch(addBusinessDaysBlock, /result\.getUTCDay\(\)/, "addBusinessDays must not classify weekends via getUTCDay()");

  const businessDaysBetweenBlock = service.match(/function businessDaysBetween\(start: Date, end: Date\) \{[\s\S]{0,400}?\n\}/)?.[0] ?? "";
  assert.match(businessDaysBetweenBlock, /cairoDayOfWeek\(cursor\)/, "businessDaysBetween must classify weekends via Cairo, not getUTCDay()");
  assert.doesNotMatch(businessDaysBetweenBlock, /cursor\.getUTCDay\(\)/, "businessDaysBetween must not classify weekends via getUTCDay()");
}

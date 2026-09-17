import assert from "node:assert/strict";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import {
  editablePlanDays,
  effectiveRamadanRanges,
  fieldWeekDays,
  fieldWeekStart,
  isFieldWeekStart,
  isIsoDay,
  isMonthKey,
  isRamadanDay,
  monthEndOf,
  monthStartOf,
  nextRamadan,
  plannableWeeks,
  planDayListTypes,
  UMM_AL_QURA_RAMADAN,
  weekdayOfIsoDay,
  type RamadanRange,
} from "../src/lib/phoenix-crm/calendar.ts";

/**
 * Phoenix CRM's calendar (the owner, 2026-09-16).
 *
 *   - The plan week is the field week the company already runs on: Saturday to Wednesday, plus
 *     Thursday MORNING (accounts only), never Friday (owner rules 2026-08-02 and 2026-09-05). A week is
 *     keyed by its Saturday, and a Friday belongs to the week before it.
 *   - A day that has passed is fixed; a rep plans this week while it has a day ahead, and three more.
 *   - Ramadan switches every customer to the "special visit time". Its dates are the Umm al-Qura
 *     calendar, pinned in calendar.ts so the server and every phone agree — this test re-derives that
 *     table from `Intl` and fails on any drift, so a wrong or hand-edited year cannot ship.
 */

function intlRamadanTable(fromDay: string, toDay: string): RamadanRange[] {
  const format = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
  assert.equal(
    format.resolvedOptions().calendar,
    "islamic-umalqura",
    "this runtime has no Umm al-Qura calendar, so the pinned Ramadan table cannot be checked (Node needs full ICU)",
  );
  const byYear = new Map<number, RamadanRange>();
  for (let day = fromDay; day <= toDay; day = addDaysIso(day, 1)) {
    const parts = format.formatToParts(new Date(`${day}T12:00:00Z`));
    if (Number(parts.find((part) => part.type === "month")?.value) !== 9) continue;
    const hijriYear = Number(String(parts.find((part) => part.type === "year")?.value ?? "").replace(/\D/g, ""));
    assert.ok(Number.isInteger(hijriYear) && hijriYear > 1400, `the Hijri year of ${day} could not be read`);
    const range = byYear.get(hijriYear);
    if (range) range.endsOn = day;
    else byYear.set(hijriYear, { hijriYear, startsOn: day, endsOn: day });
  }
  return [...byYear.values()];
}

export function runPhoenixCrmCalendarTests() {
  // ── Days and weekdays ───────────────────────────────────────────────────────────────────────────
  assert.equal(isIsoDay("2026-09-17"), true);
  assert.equal(isIsoDay("2026-02-29"), false, "2026 is not a leap year");
  assert.equal(isIsoDay("2028-02-29"), true);
  assert.equal(isIsoDay("2026-9-17"), false);
  assert.equal(isIsoDay(20260917), false);
  assert.equal(weekdayOfIsoDay("2026-09-17"), 4, "17 September 2026 is a Thursday");
  assert.equal(weekdayOfIsoDay("2026-09-19"), 6, "19 September 2026 is a Saturday");

  // ── The field week ──────────────────────────────────────────────────────────────────────────────
  assert.equal(fieldWeekStart("2026-09-19"), "2026-09-19", "a Saturday starts its own week");
  assert.equal(fieldWeekStart("2026-09-20"), "2026-09-19");
  assert.equal(fieldWeekStart("2026-09-17"), "2026-09-12", "a Thursday is the last day of the week that started on Saturday");
  assert.equal(fieldWeekStart("2026-09-18"), "2026-09-12", "a Friday belongs to the week before it, never the next");
  assert.equal(fieldWeekStart("2027-01-01"), "2026-12-26", "a week keeps its Saturday across a new year");
  assert.equal(isFieldWeekStart("2026-09-19"), true);
  assert.equal(isFieldWeekStart("2026-09-18"), false);
  assert.equal(isFieldWeekStart("not a day"), false);

  assert.deepEqual(
    fieldWeekDays("2026-10-03"),
    ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"],
    "Saturday to Thursday: six days, and Friday is never one of them",
  );
  assert.deepEqual(planDayListTypes("2026-10-03"), ["AM", "PM"], "a Saturday holds accounts and doctors");
  assert.deepEqual(planDayListTypes("2026-10-07"), ["AM", "PM"], "a Wednesday holds accounts and doctors");
  assert.deepEqual(planDayListTypes("2026-10-08"), ["AM"], "Thursday is a morning: accounts only");
  assert.deepEqual(planDayListTypes("2026-10-09"), [], "Friday holds nothing");

  // ── Which weeks can be planned, and which days can still change ─────────────────────────────────
  assert.deepEqual(
    plannableWeeks("2026-09-17"),
    ["2026-09-12", "2026-09-19", "2026-09-26", "2026-10-03"],
    "on a Thursday this week still has today, so it is offered with the next three",
  );
  assert.deepEqual(
    plannableWeeks("2026-09-18"),
    ["2026-09-19", "2026-09-26", "2026-10-03"],
    "on a Friday this week has no day left, so only the next three are offered",
  );
  assert.deepEqual(plannableWeeks("2026-09-19", 1), ["2026-09-19", "2026-09-26"]);

  assert.deepEqual(editablePlanDays("2026-09-12", "2026-09-17"), ["2026-09-17"], "a day that has passed is fixed; today can still change");
  assert.equal(editablePlanDays("2026-09-19", "2026-09-17").length, 6, "a week ahead can change in full");
  assert.deepEqual(editablePlanDays("2026-09-12", "2026-09-18"), [], "a week whose Thursday has passed is fixed");
  assert.deepEqual(editablePlanDays("2026-09-17", "2026-09-17"), [], "a week is only ever keyed by its Saturday");

  // ── Ramadan: the pinned Umm al-Qura table is exactly what Intl says ─────────────────────────────
  const derived = intlRamadanTable("2026-01-01", "2038-12-31");
  assert.deepEqual(
    UMM_AL_QURA_RAMADAN.map((range) => ({ ...range })),
    derived,
    "the pinned Ramadan dates in src/lib/phoenix-crm/calendar.ts drifted from the Umm al-Qura calendar — re-derive them, never hand-edit one year",
  );
  for (const range of UMM_AL_QURA_RAMADAN) {
    const days = Math.round((Date.parse(`${range.endsOn}T00:00:00Z`) - Date.parse(`${range.startsOn}T00:00:00Z`)) / 86_400_000) + 1;
    assert.ok(days === 29 || days === 30, `Ramadan ${range.hijriYear} lasts ${days} days`);
  }
  assert.deepEqual(
    UMM_AL_QURA_RAMADAN.find((range) => range.hijriYear === 1448),
    { hijriYear: 1448, startsOn: "2027-02-08", endsOn: "2027-03-08" },
    "the first Ramadan the module meets, as the owner was told: 8 February to 8 March 2027",
  );

  assert.equal(isRamadanDay("2027-02-07"), false);
  assert.equal(isRamadanDay("2027-02-08"), true);
  assert.equal(isRamadanDay("2027-03-08"), true);
  assert.equal(isRamadanDay("2027-03-09"), false);
  assert.equal(isRamadanDay("2026-09-17"), false);

  // The Super Admin moves a year for the moon sighting; a broken override is ignored, never half-read.
  const moved: RamadanRange[] = [{ hijriYear: 1448, startsOn: "2027-02-09", endsOn: "2027-03-09" }];
  assert.equal(isRamadanDay("2027-02-08", moved), false, "the moved year replaces the pinned one");
  assert.equal(isRamadanDay("2027-03-09", moved), true);
  assert.equal(isRamadanDay("2028-01-28", moved), true, "moving one year leaves the others pinned");
  assert.equal(isRamadanDay("2027-02-08", [{ hijriYear: 1448, startsOn: "2027-03-09", endsOn: "2027-02-09" }]), true, "an end before the start is ignored");
  assert.equal(isRamadanDay("2027-02-08", [{ hijriYear: 1448, startsOn: "2027-02-30", endsOn: "2027-03-09" }]), true, "a day that does not exist is ignored");
  assert.deepEqual(
    effectiveRamadanRanges(moved).map((range) => range.hijriYear),
    UMM_AL_QURA_RAMADAN.map((range) => range.hijriYear),
    "an override keeps one range per year, in date order",
  );

  // Outside the pinned years the runtime's own calendar answers.
  const later = intlRamadanTable("2039-01-01", "2039-12-31");
  assert.equal(later.length, 1, "one Ramadan falls in 2039");
  assert.equal(isRamadanDay(later[0].startsOn), true, "past the pinned table, Intl's Ramadan is still Ramadan");
  assert.equal(isRamadanDay(addDaysIso(later[0].startsOn, -1)), false);

  assert.deepEqual(nextRamadan("2026-09-17"), { hijriYear: 1448, startsOn: "2027-02-08", endsOn: "2027-03-08" });
  assert.equal(nextRamadan("2027-03-08")?.hijriYear, 1448, "a Ramadan's last day still shows that Ramadan");
  assert.equal(nextRamadan("2027-03-09")?.hijriYear, 1449);
  assert.equal(nextRamadan("2027-03-09", moved)?.hijriYear, 1448, "the settings screen reads the moved dates");
  assert.equal(nextRamadan("2039-01-01"), null);

  // ── Months ──────────────────────────────────────────────────────────────────────────────────────
  assert.equal(monthStartOf("2026-09-16"), "2026-09-01");
  assert.equal(monthEndOf("2026-09-16"), "2026-09-30");
  assert.equal(monthEndOf("2026-12-05"), "2026-12-31");
  assert.equal(monthEndOf("2026-02-10"), "2026-02-28");
  assert.equal(monthEndOf("2028-02-10"), "2028-02-29");
  assert.equal(isMonthKey("2026-09"), true);
  assert.equal(isMonthKey("2026-13"), false);
  assert.equal(isMonthKey("2026-9"), false);
}

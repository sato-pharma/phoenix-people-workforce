import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  describeOutstationTripDay,
  foldOutstationTripDays,
  outstationTripStateProvesWork,
} from "../src/lib/outstation/trip-work-evidence.ts";
import { selectPhoenixWorkedDays } from "../src/lib/deductions/phoenix-worked-days.ts";
import { selectProvenWorkedDays, provenWorkedDayReason } from "../src/lib/deductions/proven-worked-days.ts";
import { excludeProvenWorkedDays } from "../src/lib/deductions/connectors/crm.ts";
import { selectNoRecordsDrafts, type NoRecordsDay } from "../src/lib/daily-deductions/no-records-select.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

/**
 * NO DEDUCTION IS CHARGED FOR A DAY SOMEONE SPENT ON AN OUTSTATION TRIP (owner, 2026-10-12: "check
 * outstation trips as a deduction source too", and, asked which trip states count, "any trip not
 * rejected").
 *
 * The defect, measured on production the same day: nothing in the deduction, private-calendar or
 * attendance paths read either trip table. 1 September – 12 October 2026 held 131 trip-days, 65 of
 * them with no CRM row of any kind and no fingerprint punch — 62 chargeable days worth 69,667.47 EGP
 * across 18 people, mostly District Sales Managers and head-office managers whose travel day has no
 * doctor to visit and no office device to punch.
 *
 * What this suite pins, in the order the money flows:
 *
 *   1. HIS RULING, as a deny-list — a submitted trip spares the day, a rejected one does not, and an
 *      unknown status spares it too, because the reverse default is the one that costs someone money;
 *   2. the dating — `timestamptz` request columns through Cairo, plain `date` expense columns as
 *      written, the multi-day expansion, and the window clip;
 *   3. the fold onto the Phoenix suppression map, and the reason line a reviewer reads;
 *   4. the two connector exits a trip day leaves through;
 *   5. THE DIRECTION — a trip may only ever subtract a day, never put a person into scope.
 */

const MONTH = 9;
const YEAR = 2026;

function request(overrides: {
  employee_hr_id?: string | null;
  status?: string | null;
  to_city?: string | null;
  to_label?: string | null;
  trip_end_date?: string | null;
  trip_start_date?: string | null;
}) {
  return {
    employee_hr_id: "DM-0007",
    status: "submitted",
    to_city: null,
    to_label: null,
    trip_end_date: null,
    trip_start_date: null,
    ...overrides,
  };
}

function expense(overrides: {
  expense_date?: string | null;
  hr_id?: string | null;
  hr_status?: string | null;
  status?: string | null;
  to_date?: string | null;
  to_location?: string | null;
}) {
  return {
    expense_date: null,
    hr_id: "DM-0007",
    hr_status: null,
    status: "approved",
    to_date: null,
    to_location: null,
    ...overrides,
  };
}

function fold(input: {
  end?: string;
  expenses?: ReturnType<typeof expense>[];
  requests?: ReturnType<typeof request>[];
  start?: string;
}) {
  return foldOutstationTripDays({
    end: input.end ?? "2026-09-30",
    expenses: input.expenses ?? [],
    requests: input.requests ?? [],
    start: input.start ?? "2026-09-01",
  });
}

function draft(overrides: Partial<DeductionsCandidateDraft> = {}): DeductionsCandidateDraft {
  return {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "r1",
    employeeHrId: "DM-0007",
    employeeName: "Saad Mohamed Saad Salama",
    monthKey: `${YEAR}-${String(MONTH).padStart(2, "0")}`,
    month: MONTH,
    year: YEAR,
    unit: "days",
    rawValue: 2,
    estimatedAmount: 1_000,
    calculationStatus: "calculated",
    dates: ["2026-09-07", "2026-09-08"],
    evidence: {},
    ...overrides,
  } as DeductionsCandidateDraft;
}

// ── 1. His ruling: any trip not rejected ────────────────────────────────────────────────────────

function anyTripNotRejectedProvesTheDay(): void {
  for (const status of ["submitted", "accepted_by_admin", "accepted_by_system", "approved", "paid", "whatever_is_next"]) {
    assert.equal(outstationTripStateProvesWork(status), true, `${status} is not a rejection, so the day is spared`);
  }
  for (const status of ["rejected", "rejected_by_admin", "cancelled", "canceled", "withdrawn"]) {
    assert.equal(outstationTripStateProvesWork(status), false, `${status} proves nothing`);
  }
  // A row with no state at all is not a trip anybody filed.
  assert.equal(outstationTripStateProvesWork(null), false);
  assert.equal(outstationTripStateProvesWork("   "), false);
  // THE HEADLINE ASSERTION of the state rule: a status nobody has taught this function spares the
  // day rather than charging it. An allow-list would silently start charging on the next new state.
  assert.equal(
    fold({ requests: [request({ status: "pending_finance_review", trip_start_date: "2026-09-07T06:00:00Z" })] }).length,
    1,
    "an unrecognised state still spares the day — the reverse default is the one that costs money",
  );
  assert.deepEqual(
    fold({ requests: [request({ status: "rejected", trip_start_date: "2026-09-07T06:00:00Z" })] }),
    [],
    "a rejected trip puts the day back in scope",
  );
}

function anExpenseRowIsRefusedByEitherStatusColumn(): void {
  assert.deepEqual(
    fold({ expenses: [expense({ expense_date: "2026-09-07", hr_status: "rejected" })] }),
    [],
    "a legacy row can carry the refusal in hr_status while status still says approved",
  );
  assert.equal(
    fold({ expenses: [expense({ expense_date: "2026-09-07", hr_status: "approved", status: "approved" })] }).length,
    1,
  );
}

// ── 2. The dating ───────────────────────────────────────────────────────────────────────────────

function aCairoEveningDepartureIsDatedInCairo(): void {
  // 22:30 UTC on 7 September is 00:30 on the 8th in Cairo (UTC+2 in September, DST off).
  assert.deepEqual(
    fold({ requests: [request({ trip_start_date: "2026-09-07T22:30:00Z" })] }).map((day) => day.date),
    ["2026-09-08"],
    "the trip is dated by the Cairo calendar day, not the UTC one",
  );
  // The expense table's columns are plain `date` — already the business day, read as written.
  assert.deepEqual(
    fold({ expenses: [expense({ expense_date: "2026-09-07" })] }).map((day) => day.date),
    ["2026-09-07"],
  );
}

function aMultiDayTripProvesEveryDayIncludingTheTravelDays(): void {
  assert.deepEqual(
    fold({
      requests: [request({ trip_end_date: "2026-09-10T15:00:00Z", trip_start_date: "2026-09-08T05:00:00Z" })],
    }).map((day) => day.date),
    ["2026-09-08", "2026-09-09", "2026-09-10"],
    "the days with nothing else to show are exactly the point",
  );
  // A trip that starts before the window still covers the days inside it, and nothing outside.
  assert.deepEqual(
    fold({
      end: "2026-09-03",
      requests: [request({ trip_end_date: "2026-09-05T15:00:00Z", trip_start_date: "2026-08-30T05:00:00Z" })],
      start: "2026-09-01",
    }).map((day) => day.date),
    ["2026-09-01", "2026-09-02", "2026-09-03"],
    "the window clips both ends",
  );
  // A single-day trip stores no end date at all.
  assert.deepEqual(
    fold({ requests: [request({ trip_end_date: null, trip_start_date: "2026-09-07T05:00:00Z" })] }).map((d) => d.date),
    ["2026-09-07"],
  );
}

function aBackwardsRowProducesNothingRatherThanRunningAway(): void {
  assert.deepEqual(
    fold({ requests: [request({ trip_end_date: "2026-09-01T05:00:00Z", trip_start_date: "2026-09-09T05:00:00Z" })] }),
    [],
    "an end before its start is a bad row, not a year-long trip",
  );
}

function anAcceptedTripOutranksASubmittedOneOnTheSameDay(): void {
  const days = fold({
    expenses: [expense({ expense_date: "2026-09-07", status: "accepted_by_admin" })],
    requests: [request({ trip_start_date: "2026-09-07T05:00:00Z" })],
  });
  assert.equal(days.length, 1, "one person, one day, one row");
  assert.equal(days[0]?.status, "accepted_by_admin", "the reason line should say the stronger thing");
}

// ── 3. The fold onto the suppression map ────────────────────────────────────────────────────────

function theTripDayJoinsThePhoenixMapUnderTheSameCompactKey(): void {
  const worked = selectProvenWorkedDays({
    phoenix: selectPhoenixWorkedDays([
      { date: "2026-09-07", dayActivities: [], dayStarts: 0, hrId: "MR-0101", visits: 11 },
    ]),
    trips: fold({ requests: [request({ to_label: "Assiut", trip_start_date: "2026-09-08T05:00:00Z" })] }),
  });
  assert.deepEqual(
    [...worked.keys].sort(),
    ["dm0007:2026-09-08", "mr0101:2026-09-07"],
    "both sources land in one map, keyed ${compact}:${date}",
  );
  assert.equal(provenWorkedDayReason(worked, "mr0101:2026-09-07"), "Phoenix CRM: 11 visits");
  assert.equal(
    provenWorkedDayReason(worked, "dm0007:2026-09-08"),
    "Outstation trip to Assiut (submitted, awaiting its decision)",
    "a reviewer is told the trip is still awaiting its decision",
  );
  assert.equal(provenWorkedDayReason(worked, "dm0007:2026-09-09"), null, "no evidence, no reason");
}

function theReasonLineNamesTheDestinationWhenTheRowHasOne(): void {
  assert.equal(
    describeOutstationTripDay({ date: "2026-09-08", destination: null, hrId: "DM-0007", source: "expense", status: "approved" }),
    "Outstation trip (approved)",
  );
  assert.equal(
    describeOutstationTripDay({ date: "2026-09-08", destination: "Qena", hrId: "DM-0007", source: "request", status: "approved" }),
    "Outstation trip to Qena (approved)",
  );
}

// ── 4. The two connector exits ──────────────────────────────────────────────────────────────────

function theCrmConnectorTakesTheTripDayOffAndRepricesTheRest(): void {
  const worked = selectProvenWorkedDays({
    phoenix: selectPhoenixWorkedDays([]),
    trips: fold({ requests: [request({ trip_start_date: "2026-09-07T05:00:00Z" })] }),
  });
  const result = excludeProvenWorkedDays(draft(), worked, new Map([["dm0007", 15_000]]), "District Sales Manager");
  assert.ok(result, "the second day is still chargeable, so the candidate survives");
  // THE HEADLINE ASSERTION. Break the trip suppressor and this is the line that fires.
  assert.deepEqual(result.dates, ["2026-09-08"], "the day he was away on a filed trip is not charged");
  assert.equal(result.rawValue, 1);
  // 15,000 / 30 days in September = 500.00 a day; one full weekday.
  assert.equal(result.estimatedAmount, 500, "the money is re-priced off the surviving day");
  assert.deepEqual(
    (result.evidence as { excludedProvenWorkedDays?: string[] }).excludedProvenWorkedDays,
    ["2026-09-07"],
    "the removed day is named in the evidence, never dropped silently",
  );
}

function theDailyNoRecordsConnectorRaisesNoCandidateForATripDay(): void {
  const days: NoRecordsDay[] = [
    { date: "2026-09-07", description: "No Activity Recorded", employeeHrId: "HO-0042", employeeName: "Office Person" },
    { date: "2026-09-08", description: "No Activity Recorded", employeeHrId: "HO-0042", employeeName: "Office Person" },
  ];
  const worked = selectProvenWorkedDays({
    phoenix: selectPhoenixWorkedDays([]),
    trips: fold({ requests: [request({ employee_hr_id: "HO-0042", trip_start_date: "2026-09-07T05:00:00Z" })] }),
  });
  const drafts = selectNoRecordsDrafts({
    days,
    jobTitleByCanonicalKey: new Map([["HO-0042", "Product Manager"]]),
    outageDates: new Set<string>(),
    baseSalaryByCompact: new Map([["ho0042", 9_000]]),
    provenWorkedDayKeys: worked.keys,
    month: MONTH,
    year: YEAR,
  });
  assert.deepEqual(
    drafts.map((row) => row.dates[0]),
    ["2026-09-08"],
    "the day the trip proves he was away raises no candidate at all",
  );
}

// ── 5. The direction of the whole thing ─────────────────────────────────────────────────────────

function theTripSourceCanOnlyEverSubtractADay(): void {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  // It reaches the connectors only through the one suppressor, which is read where a charge has
  // already been decided — never where a connector decides whether a person has any signal at all.
  for (const [path, guard] of [
    ["src/lib/deductions/connectors/dsm-no-record.ts", "anySignal"],
    ["src/lib/deductions/connectors/holiday-bridge.ts", "hasAnySignalThisMonth"],
    ["src/lib/deductions/connectors/half-day.ts", "firstSignalByPerson"],
  ] as const) {
    const source = read(path);
    assert.ok(
      !source.includes("trip-work-evidence"),
      `${path} reads the trips through proven-worked-days.ts, never the trip loader directly`,
    );
    for (const line of source.split("\n")) {
      if (!line.includes("provenWorked")) continue;
      assert.ok(
        !line.includes(`${guard}.add`) && !line.includes(`${guard}.set`),
        `${path} must never write a trip day into ${guard}`,
      );
    }
  }

  // And a trip is never counted as CRM work or attendance anywhere a figure is reported.
  for (const counted of ["src/lib/crm/call-rate.ts", "src/lib/early-birds/collect.ts", "src/lib/crm/phoenix-work-evidence.ts"]) {
    assert.ok(!read(counted).includes("trip-work-evidence"), `${counted} must never read trip evidence`);
  }

  // The loader fails CLOSED: a read error throws rather than answering "no trips", which would
  // charge every travelling day it failed to read.
  const loader = read("src/lib/outstation/trip-work-evidence.ts");
  assert.ok(/throw new Error\(/.test(loader), "a failed trip read throws");
}

export function runDeductionsOutstationTripDaysTests(): void {
  anyTripNotRejectedProvesTheDay();
  anExpenseRowIsRefusedByEitherStatusColumn();
  aCairoEveningDepartureIsDatedInCairo();
  aMultiDayTripProvesEveryDayIncludingTheTravelDays();
  aBackwardsRowProducesNothingRatherThanRunningAway();
  anAcceptedTripOutranksASubmittedOneOnTheSameDay();
  theTripDayJoinsThePhoenixMapUnderTheSameCompactKey();
  theReasonLineNamesTheDestinationWhenTheRowHasOne();
  theCrmConnectorTakesTheTripDayOffAndRepricesTheRest();
  theDailyNoRecordsConnectorRaisesNoCandidateForATripDay();
  theTripSourceCanOnlyEverSubtractADay();
}

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  describePhoenixWorkEvidence,
  foldPhoenixWorkEvidence,
  indexPhoenixWorkEvidence,
  phoenixWorkEvidenceProvesWorkedDay,
  type PhoenixWorkEvidenceDay,
} from "../src/lib/crm/phoenix-work-evidence.ts";
import {
  phoenixWorkedDayKey,
  phoenixWorkedDayReason,
  selectPhoenixWorkedDays,
} from "../src/lib/deductions/phoenix-worked-days.ts";
import { provenWorkedDayReason, selectProvenWorkedDays } from "../src/lib/deductions/proven-worked-days.ts";
import { excludeProvenWorkedDays } from "../src/lib/deductions/connectors/crm.ts";
import { selectNoRecordsDrafts, type NoRecordsDay } from "../src/lib/daily-deductions/no-records-select.ts";
import { describeManagerOwnVisitDay } from "../src/lib/phoenix-crm/server/manager-plan-readers.ts";
import { phoenixWorkEvidenceActivityKind } from "../src/lib/private-calendar/phoenix-work-evidence-items.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * NO DEDUCTION IS CHARGED FOR A DAY PHOENIX CRM PROVES WAS WORKED (owner, 2026-10-12: "you must also
 * check the phoenix crm before deciding a deduction ... bec this is people money its a deduction").
 *
 * The defect, measured on production the same day: `crm_visits_unified`'s Phoenix branches are
 * INNER-JOINED to `phoenix_crm_started_team_seats()`, so a rep whose team the Super Admin has not
 * pressed Start on logs real visits that reach no deduction reader at all. 7–12 October: 121 visits,
 * 6 Medical Reps, 17 person-days, each of those days carrying 0 iReports360 rows — 14 days and
 * 7,193.54 EGP past the zero-signal guard. Nothing had been charged; this suite is what keeps it so.
 *
 * What it pins, in the order the money flows:
 *
 *   1. what counts as evidence — a visit credits everyone named on it, an unknown activity kind is
 *      dropped, and a day Phoenix only STARTED proves nothing on its own;
 *   2. the compact `${hrId}:${date}` key every connector looks the suppression up by;
 *   3. the CRM connector's exclusion: the worked day comes off, the survivors are re-priced, and a
 *      candidate whose every day was worked is dropped whole;
 *   4. the daily No-records connector's own suppression;
 *   5. THE DIRECTION OF THE WHOLE THING — it can only ever subtract. No wiring may feed a
 *      zero-signal guard, and no counted figure may read from it.
 */

const MONTH = 10;
const YEAR = 2026;

function evidence(overrides: Partial<PhoenixWorkEvidenceDay> & { date: string; hrId: string }): PhoenixWorkEvidenceDay {
  return { dayActivities: [], dayStarts: 0, visits: 0, ...overrides };
}

/**
 * The Phoenix half of the suppression map the connectors actually read. They take a
 * `ProvenWorkedDays` — Phoenix CRM folded together with the outstation trips, pinned in
 * tests/deductions-outstation-trip-days.test.ts — and this suite feeds it no trips, so every
 * assertion below is about the Phoenix source alone.
 */
function provenFromPhoenix(days: readonly PhoenixWorkEvidenceDay[]) {
  return selectProvenWorkedDays({ phoenix: selectPhoenixWorkedDays(days), trips: [] });
}

function draft(overrides: Partial<DeductionsCandidateDraft> = {}): DeductionsCandidateDraft {
  return {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "r1",
    employeeHrId: "MR-0101",
    employeeName: "Snagik Ayman",
    monthKey: `${YEAR}-${String(MONTH).padStart(2, "0")}`,
    month: MONTH,
    year: YEAR,
    unit: "days",
    rawValue: 3,
    estimatedAmount: 1_500,
    calculationStatus: "calculated",
    dates: ["2026-10-07", "2026-10-08", "2026-10-11"],
    evidence: {},
    ...overrides,
  } as DeductionsCandidateDraft;
}

// ── 1. What counts as evidence ──────────────────────────────────────────────────────────────────

function evidenceFoldCreditsEveryoneOnTheVisit(): void {
  const days = foldPhoenixWorkEvidence({
    activities: [],
    starts: [],
    visits: [
      {
        visit_date: "2026-10-07",
        rep_hr_id: "MR-0101",
        manager_hr_id: "DM-0007",
        senior_hr_id: null,
        product_manager_hr_id: "PM-0003",
      },
    ],
  });
  const byHrId = new Map(days.map((day) => [day.hrId, day]));
  assert.equal(days.length, 3, "one visit credits the rep, the manager and the product manager");
  for (const hrId of ["MR-0101", "DM-0007", "PM-0003"]) {
    assert.equal(byHrId.get(hrId)?.visits, 1, `${hrId} was on the visit and is credited exactly once`);
  }
}

function evidenceFoldDropsAnUnknownActivityKind(): void {
  const days = foldPhoenixWorkEvidence({
    activities: [
      { activity_date: "2026-10-07", rep_hr_id: "MR-0101", activity_type: "training" },
      // Not one of the seven kinds. Pardoning a day on a label nobody has classified is the riskier
      // default — the kind IS the whole record.
      { activity_date: "2026-10-08", rep_hr_id: "MR-0101", activity_type: "annual_leave" },
    ],
    starts: [],
    visits: [],
  });
  assert.deepEqual(
    days.map((day) => [day.date, day.dayActivities]),
    [["2026-10-07", ["Training"]]],
    "a known kind is carried with its label; an unknown one produces no evidence day at all",
  );
}

function aDayStartAloneProvesNothing(): void {
  assert.equal(
    phoenixWorkEvidenceProvesWorkedDay(evidence({ date: "2026-10-07", dayStarts: 1, hrId: "MR-0101" })),
    false,
    "pressing Start is not an outcome — the day goes to a reviewer, it is not pardoned",
  );
  assert.equal(
    phoenixWorkEvidenceProvesWorkedDay(evidence({ date: "2026-10-07", hrId: "MR-0101", visits: 1 })),
    true,
    "one real visit proves the day",
  );
  assert.equal(
    phoenixWorkEvidenceProvesWorkedDay(evidence({ date: "2026-10-07", dayActivities: ["Meeting"], hrId: "MR-0101" })),
    true,
    "a recorded day activity proves the day — all nine kinds are working time, and leave is not among them",
  );
}

function evidenceIsDescribedForTheReviewer(): void {
  assert.equal(
    describePhoenixWorkEvidence(evidence({ date: "2026-10-07", dayActivities: ["Meeting"], hrId: "MR-0101", visits: 4 })),
    "Phoenix CRM: 4 visits · Meeting",
  );
  assert.equal(
    describePhoenixWorkEvidence(evidence({ date: "2026-10-07", dayStarts: 1, hrId: "MR-0101" })),
    "Phoenix CRM: day started, nothing recorded after it",
  );
}

// ── 2. The key every connector looks the suppression up by ──────────────────────────────────────

function suppressionIsKeyedCompactWithAColon(): void {
  assert.equal(phoenixWorkedDayKey("MR-0101", "2026-10-07"), "mr0101:2026-10-07");
  const worked = selectPhoenixWorkedDays([
    evidence({ date: "2026-10-07", hrId: "MR-0101", visits: 18 }),
    evidence({ date: "2026-10-08", dayStarts: 1, hrId: "MR-0101" }),
  ]);
  assert.deepEqual([...worked.keys], ["mr0101:2026-10-07"], "only the day that PROVES work is suppressed");
  assert.equal(
    worked.evidence.has("mr0101:2026-10-08"),
    true,
    "the day-start day is still carried as evidence, so a reviewer sees it",
  );
  assert.equal(phoenixWorkedDayReason(worked, "mr0101:2026-10-07"), "Phoenix CRM: 18 visits");
}

function twoSpellingsOfOneHrIdAddUpRatherThanReplace(): void {
  const worked = selectPhoenixWorkedDays([
    evidence({ date: "2026-10-07", hrId: "mr-0101", visits: 2 }),
    evidence({ date: "2026-10-07", hrId: "MR0101", visits: 3 }),
  ]);
  assert.equal(worked.evidence.get("mr0101:2026-10-07")?.visits, 5, "the second spelling must not lose the first's visits");
  const indexed = indexPhoenixWorkEvidence(
    [
      evidence({ date: "2026-10-07", dayActivities: ["Meeting"], hrId: "MR-0101" }),
      evidence({ date: "2026-10-07", dayActivities: ["Meeting", "Training"], hrId: "MR-0101" }),
    ],
    (hrId) => hrId.toUpperCase(),
  );
  assert.deepEqual(
    indexed.get("MR-0101|2026-10-07")?.dayActivities,
    ["Meeting", "Training"],
    "labels merge without duplicating",
  );
}

// ── 3. The CRM connector's exclusion ───────────────────────────────────────────────────────────

function theWorkedDayComesOffAndTheSurvivorsAreRepriced(): void {
  const worked = provenFromPhoenix([evidence({ date: "2026-10-08", hrId: "MR-0101", visits: 32 })]);
  const result = excludeProvenWorkedDays(draft(), worked, new Map([["mr0101", 6_200]]), "Medical Rep");
  assert.ok(result, "two unworked days remain, so the candidate survives");
  // THE HEADLINE ASSERTION. Break the suppressor and this is the line that fires.
  assert.deepEqual(result.dates, ["2026-10-07", "2026-10-11"], "the day he logged 32 Phoenix visits is not charged");
  assert.equal(result.rawValue, 2, "rawValue reports the surviving flagged days");
  assert.deepEqual(
    (result.evidence as { excludedProvenWorkedDays?: string[] }).excludedProvenWorkedDays,
    ["2026-10-08"],
    "the removed day is named in the evidence, never dropped silently",
  );
  // 6,200 / 31 days = 200.00 a day; two full weekday days.
  assert.equal(result.estimatedAmount, 400, "the money is re-priced off the surviving weighted days");
}

function aCandidateWhoseEveryDayWasWorkedIsDroppedWhole(): void {
  const worked = provenFromPhoenix([
    evidence({ date: "2026-10-07", hrId: "MR-0101", visits: 4 }),
    evidence({ date: "2026-10-08", hrId: "MR-0101", visits: 9 }),
    evidence({ date: "2026-10-11", dayActivities: ["Training"], hrId: "MR-0101" }),
  ]);
  assert.equal(
    excludeProvenWorkedDays(draft(), worked, new Map([["mr0101", 6_200]]), "Medical Rep"),
    null,
    "nothing is left to charge",
  );
}

function aCandidateWithNoPerDayDatesIsUntouched(): void {
  const worked = provenFromPhoenix([evidence({ date: "2026-10-08", hrId: "MR-0101", visits: 32 })]);
  const dateless = draft({ dates: [], rawValue: 3 });
  assert.equal(
    excludeProvenWorkedDays(dateless, worked, new Map([["mr0101", 6_200]]), "Medical Rep"),
    dateless,
    "with no day to match, inventing one would be a guess about someone's pay",
  );
}

function anUnrelatedPersonsEvidenceNeverClearsSomeoneElsesDay(): void {
  const worked = provenFromPhoenix([evidence({ date: "2026-10-08", hrId: "MR-0999", visits: 40 })]);
  const result = excludeProvenWorkedDays(draft(), worked, new Map([["mr0101", 6_200]]), "Medical Rep");
  assert.deepEqual(result?.dates, ["2026-10-07", "2026-10-08", "2026-10-11"], "suppression is per person, never per date");
}

// ── 4. The daily No-records connector ──────────────────────────────────────────────────────────

function theDailyNoRecordsConnectorSuppressesTheSameDay(): void {
  const days: NoRecordsDay[] = [
    { date: "2026-10-07", description: "No Activity Recorded", employeeHrId: "HO-0042", employeeName: "Office Person" },
    { date: "2026-10-08", description: "No Activity Recorded", employeeHrId: "HO-0042", employeeName: "Office Person" },
  ];
  const drafts = selectNoRecordsDrafts({
    days,
    jobTitleByCanonicalKey: new Map([["HO-0042", "Product Manager"]]),
    outageDates: new Set<string>(),
    baseSalaryByCompact: new Map([["ho0042", 9_300]]),
    provenWorkedDayKeys: new Set(["ho0042:2026-10-07"]),
    month: MONTH,
    year: YEAR,
  });
  assert.deepEqual(
    drafts.map((row) => row.dates[0]),
    ["2026-10-08"],
    "the day Phoenix CRM proves he worked raises no candidate at all",
  );
}

// ── 5. The direction of the whole thing ────────────────────────────────────────────────────────

function nothingFeedsAZeroSignalGuardOrACountedFigure(): void {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  // The wirings, and the exact guard each one must stay out of. Feeding any of these would turn a
  // mapping-gap SKIP into a charge — the opposite of this change.
  for (const [path, guard] of [
    ["src/lib/deductions/connectors/dsm-no-record.ts", "anySignal"],
    ["src/lib/deductions/connectors/holiday-bridge.ts", "hasAnySignalThisMonth"],
    ["src/lib/deductions/connectors/half-day.ts", "firstSignalByPerson"],
  ] as const) {
    const source = read(path);
    assert.ok(source.includes("provenWorked"), `${path} consults the proven-worked-days suppressor`);
    for (const line of source.split("\n")) {
      if (!line.includes("provenWorked")) continue;
      assert.ok(
        !line.includes(`${guard}.add`) && !line.includes(`${guard}.set`),
        `${path} must never write proven work evidence into ${guard}`,
      );
    }
  }

  // The started-team rule is the owner's and stays: nothing here may widen what is COUNTED.
  // The loader's own prose explains the door at length; what it must never do is READ it, which
  // would make the suppressor inherit the started-team gate that is the whole defect.
  const loader = read("src/lib/crm/phoenix-work-evidence.ts");
  assert.ok(
    !/\.from\(\s*["'`]crm_visits_unified/.test(loader) && !/from "@\/lib\/crm\/(reads|tables)"/.test(loader),
    "the suppressor reads the Phoenix CRM tables directly and never goes through the counting door",
  );
  for (const counted of [
    "src/lib/crm/call-rate.ts",
    "src/lib/early-birds/collect.ts",
  ]) {
    assert.ok(
      !read(counted).includes("phoenix-work-evidence"),
      `${counted} is a COUNTED figure and must never read work evidence`,
    );
  }
}

// ── The private calendar's colour ──────────────────────────────────────────────────────────────

function theCalendarShowsTheDayAsFieldWork(): void {
  assert.equal(
    phoenixWorkEvidenceActivityKind(evidence({ date: "2026-10-07", hrId: "MR-0101", visits: 18 })),
    "single_regular",
  );
  assert.equal(
    phoenixWorkEvidenceActivityKind(evidence({ date: "2026-10-07", dayActivities: ["Training"], hrId: "MR-0101" })),
    "other_crm",
  );
}

/**
 * A manager's OWN single visits are the third source of the suppression map (owner, 2026-10-19,
 * asked in so many words and answered "count it on both").
 *
 * Since 16 Oct 2026 a district manager's own visit is written to a table of its own and no longer to
 * `phoenix_crm_visits`, so source 1 above cannot see it: a manager who spent the whole day on his own
 * single visits had no record anywhere a deduction reader looks. Measured on production 2026-10-19 —
 * two district managers, no CRM row, no punch, no vacation, no trip between them.
 */
function aManagersOwnSingleVisitsSuppressHisDay(): void {
  const proven = selectProvenWorkedDays({
    managerOwnVisits: [{ date: "2026-10-19", hrId: "B-116", visits: 1 }],
    phoenix: selectPhoenixWorkedDays([]),
    trips: [],
  });
  const key = phoenixWorkedDayKey("B-116", "2026-10-19");
  assert.ok(key, "the key is readable");
  assert.equal(proven.keys.has(key), true, "a day he logged his own single visits on is a day he provably worked");
  assert.equal(
    provenWorkedDayReason(proven, key),
    "Phoenix CRM: 1 own single visit",
    "and the connector prints what proved it, in the singular for one",
  );
  assert.equal(
    describeManagerOwnVisitDay({ date: "2026-10-19", hrId: "B-116", visits: 3 }),
    "Phoenix CRM: 3 own single visits",
    "plural above one",
  );

  // Nobody else's day moves, and a day with none of his visits is untouched.
  const otherKey = phoenixWorkedDayKey("B-120", "2026-10-19");
  assert.ok(otherKey);
  assert.equal(proven.keys.has(otherKey), false, "another manager's day is not suppressed by his");
  const anotherDay = phoenixWorkedDayKey("B-116", "2026-10-18");
  assert.ok(anotherDay);
  assert.equal(proven.keys.has(anotherDay), false, "nor is a day he logged nothing on");

  // A day a trip already explains keeps the TRIP's reason: the fold runs last, and it only ever adds.
  const withTrip = selectProvenWorkedDays({
    managerOwnVisits: [{ date: "2026-10-19", hrId: "B-116", visits: 2 }],
    phoenix: selectPhoenixWorkedDays([]),
    trips: [{ date: "2026-10-19", destination: "Alexandria", hrId: "B-116", source: "request", status: "approved" }],
  });
  assert.equal(withTrip.keys.has(key), true, "the day is suppressed either way");
  assert.notEqual(provenWorkedDayReason(withTrip, key), "Phoenix CRM: 2 own single visits", "the first writer's reason stands");

  // 🔴 THE DIRECTION: it may only ever remove a charge. Omitting the source entirely must change
  // nothing but the one day, never add a key.
  const without = selectProvenWorkedDays({ phoenix: selectPhoenixWorkedDays([]), trips: [] });
  assert.equal(without.keys.size, 0, "with no source at all nothing is suppressed — a failed read charges, never excuses");
}

/** The loader reads the third source, and the private calendar and the absence calendar read the same one. */
function everyReaderOfHisOwnVisitsGoesThroughTheOneAdapter(): void {
  const proven = stripComments(readFileSync("src/lib/deductions/proven-worked-days.ts", "utf8"));
  assert.match(
    proven,
    /loadManagerOwnVisitDays\(\{ end: input\.end, start: input\.start \}\)/,
    "the suppression map loads a manager's own single visits",
  );
  assert.match(proven, /@\/lib\/phoenix-crm\/server\/manager-plan-readers/, "through the one adapter, never the table");

  const items = stripComments(readFileSync("src/lib/private-calendar/manager-own-visit-items.ts", "utf8"));
  assert.match(items, /@\/lib\/phoenix-crm\/server\/manager-plan-readers/, "and so does the private calendar's item source");
  assert.match(items, /source: "field_visit"/, "it is his own field work, so the engine's field-visit suppression treats it identically");
  assert.match(items, /catch \{\s*return \{ items: \[\], ready: false \};/, "a failed read degrades the calendar rather than taking it down");

  const service = stripComments(readFileSync("src/lib/private-calendar/service.ts", "utf8"));
  assert.equal(
    (service.match(/loadManagerOwnVisitPrivateCalendarItems\(/g) ?? []).length,
    3,
    "all three private-calendar passes read it — the workspace, the company-wide pass the deduction connector adjudicates, and the dispute review",
  );
  assert.equal(
    (service.match(/\.\.\.managerOwnVisits\.items,/g) ?? []).length,
    3,
    "and all three fold its items in",
  );
  assert.match(service, /!managerOwnVisits\.ready/, "an unreadable read leaves the field-visit source unready rather than silently short");

  const evidence = stripComments(readFileSync("src/lib/field-absence/server/evidence.ts", "utf8"));
  assert.match(evidence, /loadManagerOwnVisitDays\(\{ end: input\.end, managerHrIds: \[\.\.\.input\.hrIds\], start: input\.start \}\)/, "the Field Absence Calendar reads it too");
  assert.match(evidence, /addSeen\(seen, canonicalHrIdForDisplay\(day\.hrId\), day\.date, describeManagerOwnVisitDay\(day\)\)/, "and names the day by what it was");
}

export function runDeductionsPhoenixWorkEvidenceTests(): void {
  aManagersOwnSingleVisitsSuppressHisDay();
  everyReaderOfHisOwnVisitsGoesThroughTheOneAdapter();
  evidenceFoldCreditsEveryoneOnTheVisit();
  evidenceFoldDropsAnUnknownActivityKind();
  aDayStartAloneProvesNothing();
  evidenceIsDescribedForTheReviewer();
  suppressionIsKeyedCompactWithAColon();
  twoSpellingsOfOneHrIdAddUpRatherThanReplace();
  theWorkedDayComesOffAndTheSurvivorsAreRepriced();
  aCandidateWhoseEveryDayWasWorkedIsDroppedWhole();
  aCandidateWithNoPerDayDatesIsUntouched();
  anUnrelatedPersonsEvidenceNeverClearsSomeoneElsesDay();
  theDailyNoRecordsConnectorSuppressesTheSameDay();
  nothingFeedsAZeroSignalGuardOrACountedFigure();
  theCalendarShowsTheDayAsFieldWork();
}

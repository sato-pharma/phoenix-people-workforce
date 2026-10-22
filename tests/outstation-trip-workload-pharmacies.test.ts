import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { DoubleVisitExpenseWorkloadEvidence } from "../src/lib/double-visit-analytics/types.ts";
import type { RepVisitWorkload } from "../src/lib/crm/visit-workload.ts";
import { addVisitToSplit, emptyVisitCountSplit } from "../src/lib/crm/visit-count-buckets.ts";
import { outstationPharmacyWorkload } from "../src/lib/outstation/payroll-expense-mapping.ts";
import { mergeWorkloadEvidence } from "../src/lib/outstation/workload-evidence.ts";
import { capturedWorkloadMatchStatus, rollUpManagerTripWorkload } from "../src/lib/outstation/workload-rollup.ts";

// THE AM · PM · PHARMACIES GOLDEN RULE, on the outstation trip workload (owner, 2026-09-21).
//
// Every count of CRM visits is three figures apart: AM, PM (the doctors) and Pharmacies. The trip
// workload was the last count still filing a pharmacy visit by its vendor-tagged period — on
// production that put 52 pharmacy visits across 16 of 127 trips inside AM or PM. The owner then
// chose "Third figure, counts as work": pharmacies leave AM and PM, but a trip day with only
// pharmacy visits is still a worked day, so it never reads "No activity".
//
// Money: nothing pays from these figures. The workload gate clears on capture, and the campaign
// cap in decision.ts reads double-visit counts — which is why the last check here keeps that file
// pharmacy-blind.

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const DAY1 = "2026-09-15";
const DAY2 = "2026-09-16";

export function runOutstationTripWorkloadPharmaciesTests() {
  // 1. THE COUNTER. A trip visit is bucketed by the one helper, so a pharmacy the vendor tagged
  // "PM" (1,827 of them in six weeks) or "AM" lands in Pharmacies — never among the doctors.
  const counter = source("../src/lib/crm/visit-workload.ts");
  assert.match(
    counter,
    /addVisitToSplit\(entry, row\)/,
    "the trip counter must bucket each visit with addVisitToSplit — the one test of what a pharmacy visit is",
  );
  assert.doesNotMatch(
    counter,
    /entry\.pm \+= 1/,
    "the trip counter must never add a visit to PM by its period alone — that is how pharmacies were filed among the doctors",
  );
  assert.doesNotMatch(
    counter,
    /ampm\.startsWith\("A"\)/,
    "no period-only AM/PM split may come back into the trip counter",
  );

  const day = { am: 0, pm: 0, pharmacies: 0 };
  addVisitToSplit(day, { ampm: "PM", speciality: "Pharmacy", visit_type: 0 });
  addVisitToSplit(day, { ampm: "AM", speciality: "Pharmacy", visit_type: -8 });
  addVisitToSplit(day, { ampm: "PM", speciality: "Cardiology", visit_type: 0 });
  addVisitToSplit(day, { ampm: "AM", speciality: "Hospital", visit_type: 0 });
  addVisitToSplit(day, { ampm: null, speciality: "Pediatrics", visit_type: 0 });
  assert.deepEqual(
    day,
    { am: 1, pm: 2, pharmacies: 2 },
    "a pharmacy is Pharmacies whatever its period, a doctor keeps his period, and an unmarked period stays PM",
  );

  // 2. THE ROLLUP keeps the third figure apart, per day and for the trip.
  const rolled = rollUpManagerTripWorkload({
    dates: [DAY1, DAY2],
    hops: 1,
    partnersByPersonDate: { "HR-NSM": { [DAY1]: ["HR-DM"] } },
    rootHrId: "HR-NSM",
    workloadByPerson: {
      "HR-NSM": [{ am: 1, date: DAY1, pharmacies: 0, pm: 0 }],
      "HR-DM": [
        { am: 2, date: DAY1, pharmacies: 3, pm: 4 },
        { am: 9, date: DAY2, pharmacies: 9, pm: 9 },
      ],
    },
  });
  const day1 = rolled.days.find((row) => row.date === DAY1);
  assert.equal(day1?.am, 3, "AM rolls up without the pharmacies");
  assert.equal(day1?.pm, 4, "PM rolls up without the pharmacies — the doctors only");
  assert.equal(day1?.pharmacies, 3, "the pharmacies roll up as their own figure");
  assert.equal(rolled.amWorkload, 3);
  assert.equal(rolled.pmWorkload, 4, "the trip PM total never absorbs a pharmacy visit");
  assert.equal(rolled.pharmacyWorkload, 3, "the trip carries its pharmacy total apart (day 2 was not his DM day)");

  // 3. THE OWNER'S DECISION. A trip whose only visits were pharmacies is WORKED.
  assert.equal(
    capturedWorkloadMatchStatus({ amWorkload: 0, pharmacyWorkload: 4, pmWorkload: 0 }),
    "matched",
    "a pharmacy-only trip must never be stamped 'no activity' — that reads to an approver as 'he did nothing'",
  );
  assert.equal(capturedWorkloadMatchStatus({ amWorkload: 0, pharmacyWorkload: 0, pmWorkload: 0 }), "no_activity");
  assert.equal(capturedWorkloadMatchStatus({ amWorkload: 2, pharmacyWorkload: 0, pmWorkload: 0 }), "matched");

  const pharmacyOnlyDay = rollUpManagerTripWorkload({
    dates: [DAY1],
    hops: 0,
    partnersByPersonDate: {},
    rootHrId: "HR-REP",
    workloadByPerson: { "HR-REP": [{ am: 0, date: DAY1, pharmacies: 5, pm: 0 }] },
  });
  assert.equal(
    capturedWorkloadMatchStatus(pharmacyOnlyDay),
    "matched",
    "end to end through the rollup, a pharmacy-only trip day is a worked day",
  );

  // 4. THE SUBMIT PATH carries the third figure from the CRM read into the stored evidence.
  const doubleVisit: DoubleVisitExpenseWorkloadEvidence = {
    amWorkload: 0,
    campaignVisits: 0,
    dateBreakdown: [],
    importId: null,
    matchStatus: "no_activity",
    matchedDates: [],
    missingDates: [DAY1],
    pmWorkload: 0,
    regularVisits: 0,
    source: "double_visit_import",
    sourceLabel: "Double Visit import",
  };
  const repWorkload: RepVisitWorkload = {
    amWorkload: 0,
    campaignVisits: 0,
    dateBreakdown: [
      { am: 0, campaign: 0, checkins: [], date: DAY1, doctor: 0, institution: 0, other: 0, pharmacies: 4, pharmacy: 4, pm: 0, regular: 4, total: 4, visits: [] },
    ],
    doctorVisits: 0,
    idleDates: [],
    institutionVisits: 0,
    matchStatus: "matched",
    matchedDates: [DAY1],
    otherVisits: 0,
    pharmacyVisits: 4,
    pharmacyWorkload: 4,
    pmWorkload: 0,
    regularVisits: 4,
    sourceLabel: "Live iReports360 Visits Report.",
  };
  const merged = mergeWorkloadEvidence(doubleVisit, repWorkload);
  assert.equal(merged.pmWorkload, 0, "the stored PM figure holds no pharmacy visit");
  assert.equal(merged.pharmacyWorkload, 4, "the stored evidence carries the pharmacy figure apart");
  assert.equal(merged.dateBreakdown[0]?.pharmacies, 4, "and per day");
  assert.equal(merged.matchStatus, "matched", "a pharmacy-only trip is matched at submission too");

  // 5. THE CAPTURE PATH writes the third figure and stamps its verdict from all three.
  const service = source("../src/lib/outstation/service.ts");
  // Since 2026-10-22 the capture writes ONE shared stamp shape (workload-stamp.ts), the same one the
  // next-morning refresh writes, so the two pins below read that shape and the capture must use it.
  const stamp = source("../src/lib/outstation/workload-stamp.ts");
  assert.match(
    service,
    /\.\.\.capturedWorkloadColumns\(capture, now\)/,
    "the workload capture must write the shared stamp shape",
  );
  assert.match(
    stamp,
    /pharmacy_workload: capture\.pharmacyWorkload/,
    "the workload capture must write the pharmacy figure it measured",
  );
  assert.match(
    stamp,
    /workload_match_status: capturedWorkloadMatchStatus\(capture\)/,
    "the capture verdict must come from AM + PM + Pharmacies, or a pharmacy-only trip reads 'no activity'",
  );
  assert.match(
    service,
    /pharmacy_workload: evidence\.pharmacyWorkload \?\? 0/,
    "the submit path must write the pharmacy figure from the merged evidence",
  );
  const capture = source("../src/lib/outstation/workload-capture.ts");
  assert.match(
    capture,
    /pharmacies: day\.pharmacies/,
    "the capture must hand each person's pharmacy count to the rollup, not drop it",
  );

  // 6. NULL IS NOT ZERO. A trip stamped before the split holds its pharmacies inside AM/PM with no
  // third figure; reading that as 0 would print "no pharmacy visits" about a trip that had them.
  assert.equal(outstationPharmacyWorkload(null), null, "a pre-split row reads 'not counted separately'");
  assert.equal(outstationPharmacyWorkload(undefined), null);
  assert.equal(outstationPharmacyWorkload(""), null);
  assert.equal(outstationPharmacyWorkload(0), 0, "a counted zero stays a zero");
  assert.equal(outstationPharmacyWorkload("3"), 3, "numeric columns arrive as strings from PostgREST");
  assert.match(
    service,
    /pharmacy_workload: null/,
    "a hand-typed workload is AM and PM only, so it must clear the pharmacy figure rather than leave a stale one",
  );

  // 7. THE MONEY STAYS PHARMACY-BLIND. The campaign cap rejects on double-visit counts; a pharmacy
  // figure reaching the decision engine would move outstation money with nobody deciding it.
  const decision = source("../src/lib/outstation/decision.ts");
  assert.doesNotMatch(
    decision,
    /pharmacy_?workload/i,
    "decision.ts must not read the pharmacy workload — the owner decides money in the app, never through this figure",
  );

  // The split type is shared with every other count — one shape, never a second copy.
  assert.deepEqual(emptyVisitCountSplit(), { am: 0, pm: 0, pharmacies: 0 });
}

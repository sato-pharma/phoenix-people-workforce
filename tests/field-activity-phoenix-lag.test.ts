import { strict as assert } from "node:assert";

import {
  buildFieldActivityReport,
  type FieldActivityCheckinRow,
  type FieldActivitySubject,
  type FieldActivityVisitRow,
} from "../src/lib/field-activity/model.ts";
import { legDistanceLabel, loggingWindowNote, stopLogNote } from "../src/lib/field-activity/format.ts";

const SUBJECT: FieldActivitySubject = {
  areaName: null,
  hrId: "B-100",
  jobTitle: "Medical Rep",
  lineName: "Pedia",
  name: "A Medical Rep",
  regionName: null,
};

function visit(overrides: Partial<FieldActivityVisitRow> = {}): FieldActivityVisitRow {
  return {
    agentCrmId: 1397,
    agentHrId: "B-100",
    agentName: "A Medical Rep",
    ampm: "AM",
    comment: null,
    contactCrmId: 500,
    contactGrade: "A",
    contactName: "A Doctor",
    doubleHrId: null,
    doubleName: null,
    double2HrId: null,
    double2Name: null,
    savedAt: "2026-09-20 10:30:00+00",
    speciality: "Pediatrics",
    visitDate: "2026-09-20",
    visitType: 0,
    visitTypeDescription: "Regular Visit",
    ...overrides,
  };
}

function checkin(overrides: Partial<FieldActivityCheckinRow> = {}): FieldActivityCheckinRow {
  return {
    address: null,
    agentCrmId: 1397,
    agentHrId: "B-100",
    checkedAt: "2026-09-20 10:00:00+00",
    contactCrmId: 500,
    contactName: "A Doctor",
    lat: 30.0,
    lon: 31.0,
    ...overrides,
  };
}

function run(visits: FieldActivityVisitRow[], checkins: FieldActivityCheckinRow[]) {
  return buildFieldActivityReport({
    checkins,
    fromIso: "2026-09-20",
    leave: [],
    punches: [],
    subject: SUBJECT,
    toIso: "2026-09-20",
    trips: [],
    visits,
  });
}

// A Phoenix CRM visit is saved at its own check-in, so the door-to-log subtraction always read 0.
const PHOENIX_VISIT = visit({
  contactCrmId: 501,
  contactName: "A Phoenix Doctor",
  savedAt: "2026-09-20 12:00:00+00",
  source: "phoenix",
  form_open_seconds: 73,
});
const PHOENIX_CHECKIN = checkin({ checkedAt: "2026-09-20 12:00:00+00", contactCrmId: 501, contactName: "A Phoenix Doctor" });

/**
 * Field Activity — a Phoenix CRM visit has no logging lag to measure.
 *
 * Its check-in IS its log, so the old subtraction printed "0 min later" on every Phoenix stop and
 * pulled a rep's day average toward zero. The lag is now null for a Phoenix stop and left out of
 * the average; the iReports360 lag is untouched.
 */
export async function runFieldActivityPhoenixLagTests() {
  // ── a Phoenix stop carries no lag, and the day average ignores it ─────────────────────────────
  {
    const report = run([visit(), PHOENIX_VISIT], [checkin(), PHOENIX_CHECKIN]);
    const day = report.days[0];
    assert.equal(day.stops.length, 2, "both visits are located stops");
    const vendor = day.stops.find((stop) => !stop.phoenixVisit);
    const phoenix = day.stops.find((stop) => stop.phoenixVisit);
    assert.ok(vendor && phoenix, "one iReports360 stop and one Phoenix stop");
    assert.equal(vendor.logLagMinutes, 30, "the iReports360 lag is still the door-to-log gap");
    assert.equal(phoenix.logLagMinutes, null, "a Phoenix stop's lag is not measured — never 0");
    assert.equal(phoenix.formOpenSeconds, 73, "the form-open seconds ride along from the visit row");
    assert.equal(day.averageLogLagMinutes, 30, "the day average is the iReports360 calls only — 30, not 15");
    assert.match(stopLogNote(phoenix), /Phoenix CRM, saved at check-in · form open 73 s/);
    assert.equal(stopLogNote(vendor), "30 min later");
    assert.match(loggingWindowNote(day), /iReports360 calls only/, "a mixed day says what the average covers");
  }

  // ── a Phoenix-only day says the lag is not measured, never "average 0 min" ────────────────────
  {
    const day = run([PHOENIX_VISIT], [PHOENIX_CHECKIN]).days[0];
    assert.equal(day.averageLogLagMinutes, null, "no measured lag means no average");
    assert.match(loggingWindowNote(day), /not measured for Phoenix CRM visits/);
    assert.doesNotMatch(loggingWindowNote(day), /average 0 min/);
  }

  // ── a leg reads in kilometres from 1,000 m up ─────────────────────────────────────────────────
  {
    assert.equal(legDistanceLabel(21054), "21.05 km");
    assert.equal(legDistanceLabel(1000), "1.00 km");
    assert.equal(legDistanceLabel(999), "999 m");
  }
}

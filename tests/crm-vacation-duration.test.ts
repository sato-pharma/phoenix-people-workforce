import assert from "node:assert/strict";

import { buildVacationPeriod, type VacationDayRow } from "../src/lib/crm/master.ts";

// Regression for #1523. `buildVacationPeriod` summed 0.5 per AM/PM ROW and 1 per full-day ROW, but
// the iReports360 mirror really does carry duplicate rows for the same agent/date/AM-PM marker —
// 39 such groups covering 50 extra rows in production. A single AM half-day logged twice therefore
// read as a FULL day, and `half_days` (documented as "how many days of this period were halves")
// counted rows rather than dates, so the same duplicate also made half_days overshoot.
//
// The fix collapses per calendar DATE before summing:
//   any full-day marker on a date  -> 1 day
//   otherwise                      -> 0.5 x DISTINCT half markers, capped at 1
// so a genuine AM + PM pair is still a full day while a duplicated AM + AM is still a half. That
// distinction is the whole point, and it is what the AM+PM / AM+AM pairs below pin: any
// implementation that counts rows makes those two cases identical.

let nextId = 1;

function day(date: string, ampm: string | null): VacationDayRow {
  return {
    agent_crm_id: 42,
    agent_hr_id: "PH-0042",
    agent_name: "Test Agent",
    ampm,
    comment: null,
    crm_visit_id: nextId++,
    visit_date: date,
    visit_type_description: "Annual Vacation",
  };
}

export function runCrmVacationDurationTests() {
  // ── AM + PM on one date is a full day; AM + AM (a duplicate) is still a half ─────
  // Row-counting gives 1 for BOTH, so these two assertions together are what separates a correct
  // implementation from the one this test exists to prevent.
  {
    const amPm = buildVacationPeriod([day("2026-07-01", "AM"), day("2026-07-01", "PM")]);
    assert.equal(amPm.duration, 1, "a real AM + PM pair on one date is a full day");
    assert.equal(amPm.half_days, 0, "a date that resolved to a full day is not a half-day");

    const amAm = buildVacationPeriod([day("2026-07-02", "AM"), day("2026-07-02", "AM")]);
    assert.equal(amAm.duration, 0.5, "a duplicated AM half-day must stay half a day, not become a full one");
    assert.equal(amAm.half_days, 1, "half_days counts DATES that resolved to half a day");
  }

  // ── A lone half-day, and a lone full day ────────────────────────────────────────
  {
    const half = buildVacationPeriod([day("2026-07-01", "AM")]);
    assert.equal(half.duration, 0.5, "a single AM row is half a day");
    assert.equal(half.half_days, 1);

    const full = buildVacationPeriod([day("2026-07-01", null)]);
    assert.equal(full.duration, 1, "a row with no AM/PM marker is a full day");
    assert.equal(full.half_days, 0);
  }

  // ── A duplicated FULL day must not become two days ──────────────────────────────
  {
    const period = buildVacationPeriod([day("2026-07-01", null), day("2026-07-01", null)]);
    assert.equal(period.duration, 1, "the same full day logged twice is still one day");
    assert.equal(period.half_days, 0);
  }

  // ── A full-day marker wins over a half on the same date ─────────────────────────
  {
    const period = buildVacationPeriod([day("2026-07-01", "AM"), day("2026-07-01", null)]);
    assert.equal(period.duration, 1, "any full-day marker on a date makes that date a whole day");
    assert.equal(period.half_days, 0, "a date resolved by a full-day marker is not counted as a half");
  }

  // ── Three markers on one date still cap at a single day ─────────────────────────
  {
    const period = buildVacationPeriod([day("2026-07-01", "AM"), day("2026-07-01", "PM"), day("2026-07-01", "AM")]);
    assert.equal(period.duration, 1, "0.5 per DISTINCT marker, capped at 1 — a date can never exceed one day");
    assert.equal(period.half_days, 0);
  }

  // ── A multi-day run mixes full, half and duplicated dates correctly ─────────────
  {
    const period = buildVacationPeriod([
      day("2026-07-01", null), // full                     -> 1
      day("2026-07-02", "AM"),
      day("2026-07-02", "PM"), // real AM+PM pair          -> 1
      day("2026-07-03", "PM"),
      day("2026-07-03", "PM"), // duplicated PM half       -> 0.5
      day("2026-07-04", "AM"), // lone AM half             -> 0.5
    ]);
    assert.equal(period.duration, 3, "6 rows across 4 dates = 1 + 1 + 0.5 + 0.5 (row-counting gives 3.5)");
    assert.equal(period.half_days, 2, "only 07-03 and 07-04 resolved to half a day");
    assert.equal(period.from_date, "2026-07-01");
    assert.equal(period.to_date, "2026-07-04");
  }

  // ── Duplicates must not disturb the period's identity or its raw payload ────────
  // vacation_id is the MIN crm_visit_id of the run and is what cross-references a period between
  // views, so the de-duplication must not drop the row that carries the lowest id.
  {
    const rows = [day("2026-07-01", "AM"), day("2026-07-01", "AM"), day("2026-07-02", "PM")];
    const ids = rows.map((r) => r.crm_visit_id as number);
    const period = buildVacationPeriod(rows);
    assert.equal(period.vacation_id, Math.min(...ids), "vacation_id stays the earliest CRM visit id");
    assert.deepEqual(
      (period.raw_payload as { visit_ids: number[] }).visit_ids,
      ids,
      "raw_payload keeps EVERY underlying row, including the duplicates — the collapse is for counting only",
    );
    assert.equal(period.duration, 1, "0.5 (duplicated AM) + 0.5 (PM) = 1");
  }

  // ── A timestamped visit_date is collapsed on its calendar date ──────────────────
  // visit_date is sliced to YYYY-MM-DD everywhere else in this function; two rows for the same date
  // must group together even when one carries a time component.
  {
    const period = buildVacationPeriod([day("2026-07-01T00:00:00Z", "AM"), day("2026-07-01", "AM")]);
    assert.equal(period.duration, 0.5, "same calendar date must collapse regardless of a time suffix");
    assert.equal(period.half_days, 1);
  }

  console.log("crm vacation duration: per-date collapse passed (AM+PM = 1 day, AM+AM = 0.5)");
}

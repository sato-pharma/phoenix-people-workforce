import assert from "node:assert/strict";

import {
  buildRepKpiReports,
  DEFAULT_REP_KPI_STANDARDS,
  type KpiPanelContact,
  type KpiVisitInput,
} from "../src/lib/crm/rep-kpi-reports.ts";

/**
 * THE 8-12 BAND IS PM ALONE — and a rep's AM calls can never be counted into it.
 *
 * WHAT THIS EXISTS TO STOP. On 2026-09-05 two readings of the owner's "8-12" shipped to `main`
 * 22 minutes apart. rep-kpi-reports.ts banded PM alone; call-rate.ts banded an AM + PM SUM. Both
 * were his own words, days apart, and neither PR was wrong to read it the way it did. Asked
 * directly on 2026-09-06 he settled it — "8-12 pm only and 2 am accounts", restated as "pm band
 * 8-12 and monthly cr target 10", and to a second session as "10 PM - 2 AM". PR #3341 then
 * retracted the combined band, leaving THIS module as the single authority.
 *
 * Nothing pinned that. The combined model was arrived at once from the owner's own earlier and
 * more general wording, and could be re-derived the same way by the next session reading it — so
 * the rule needs a test that fails loudly, not a comment that can be read past.
 *
 * THE CASE THAT SEPARATES THE TWO READINGS is the only one that can tell them apart, and it is why
 * this file is not covered by the existing band tests in tests/two-kpi-reports-per-rep.test.ts.
 * Those pin the EDGES — 8 meets, 13 does not — using panels that are pure PM, so a combined
 * implementation would pass every one of them unchanged. What separates the readings is a rep who
 * does BOTH: 7 PM and 2 AM calls in a working day. Summed that is 9 a day and reads in-band; on PM
 * alone it is 7 and reads BELOW, which is the answer.
 *
 * It is not a corner case. Measured on production for August 2026 (Sat-Wed, 23 working days, 76
 * medical reps), the two readings gave a DIFFERENT verdict for 30 reps — 24 of them in exactly
 * this direction, reading in-band when summed and below on PM alone.
 */
export function runPmCallRateBandTests() {
  const contact = (contactCrmId: number, listType: "AM" | "PM"): KpiPanelContact => ({
    contactCrmId,
    listType,
    grade: "A",
  });
  // One working day, so calls-per-day is the call count itself and the arithmetic cannot hide
  // behind a denominator.
  const on = (contactCrmId: number): KpiVisitInput => ({ contactCrmId, visitDateIso: "2026-08-01" });

  // A rep who logs 7 PM and 2 AM verified calls in one working day.
  const pmContacts = [1, 2, 3, 4, 5, 6, 7].map((id) => contact(id, "PM"));
  const amContacts = [101, 102].map((id) => contact(id, "AM"));
  const report = buildRepKpiReports({
    repHrId: "B-155",
    repName: "Seven PM Two AM",
    month: "2026-08",
    workingDays: 1,
    panel: [...pmContacts, ...amContacts],
    visits: [...pmContacts, ...amContacts].map((c) => on(c.contactCrmId)),
  });

  // ── The separating assertion ────────────────────────────────────────────────────────────────

  const pm = report.ampm.pm.callRate;
  assert.equal(pm.visits, 7, "the PM list saw 7 calls");
  assert.equal(pm.perWorkingDay, 7, "7 PM calls over one working day is 7 a day");
  assert.notEqual(
    pm.perWorkingDay,
    9,
    "9 is 7 PM + 2 AM — the combined reading the owner ruled against. Reaching it means AM has been folded back into the PM figure",
  );
  assert.ok(pm.score.scored, "the rep worked a countable day, so PM is scored rather than excused");
  assert.equal(
    pm.score.meets,
    false,
    "7 a day is BELOW the 8-12 band — this is the verdict that reads as 'in-band' under the retired combined model",
  );

  // ── The same rep passes AM at the same moment, and the two are never merged ─────────────────

  // This pair is the owner's whole point (2026-09-04, "this two and this ten. Don't never get
  // average"): a good morning must not pay for an afternoon that did not happen. Reported apart,
  // this rep is ON his AM standard and BELOW his PM band simultaneously.
  const am = report.ampm.am.callRate;
  assert.equal(am.visits, 2, "the AM calls are real, are counted, and are judged — just not here");
  assert.equal(am.perWorkingDay, 2, "2 AM accounts over one working day is exactly the AM standard");
  assert.ok(am.score.scored && am.score.meets, "so the rep MEETS AM in the very month he misses PM");

  // ── The standards themselves ────────────────────────────────────────────────────────────────

  // AM must never acquire a band. Giving it one is the reading that was retracted, and it would
  // reintroduce the combined model by the back door — a band on both lists invites summing them.
  assert.equal(
    DEFAULT_REP_KPI_STANDARDS.AM.callRateBand,
    null,
    "AM is a flat target of 2 with NO band — a band here is the retired reading returning",
  );
  assert.equal(DEFAULT_REP_KPI_STANDARDS.AM.callRatePerDay, 2, "the owner's '2 am accounts'");
  assert.deepEqual(
    DEFAULT_REP_KPI_STANDARDS.PM.callRateBand,
    { min: 8, max: 12 },
    "the band belongs to PM and only to PM",
  );
  assert.equal(
    DEFAULT_REP_KPI_STANDARDS.PM.callRatePerDay,
    10,
    "and sits around a target of 10, which is the band's own midpoint",
  );

  // The band's lower edge is a PASS, which is the entire reason the owner stated a band rather than
  // a bare target — and the nuance that would be lost by "fixing" PM to a flat >= 10.
  const eightPm = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => contact(id, "PM"));
  const eight = buildRepKpiReports({
    repHrId: "B-155",
    repName: "Eight PM",
    month: "2026-08",
    workingDays: 1,
    panel: eightPm,
    visits: eightPm.map((c) => on(c.contactCrmId)),
  });
  assert.ok(
    eight.ampm.pm.callRate.score.meets,
    "8 PM calls a day MEETS the standard even though the headline target is 10",
  );
}

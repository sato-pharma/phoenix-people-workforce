import assert from "node:assert/strict";

import {
  AM_CALL_RATE_TARGET,
  PM_CALL_RATE_BAND_MAX,
  PM_CALL_RATE_BAND_MIN,
  PM_CALL_RATE_TARGET,
  pmCallRateBandOf,
  pmVerifiedPerDay,
  type RepCallRate,
} from "../src/lib/crm/call-rate.ts";
import { joinKpiRows } from "../src/lib/crm/kpis-board.ts";
import { kpiFlagsOf } from "../src/lib/crm/kpis-filters.ts";
import { DEFAULT_REP_KPI_STANDARDS } from "../src/lib/crm/rep-kpi-reports.ts";

/**
 * THE 8-12 BAND JUDGES PM ALONE — the owner settled it on 2026-09-06.
 *
 * Two readings of his "8-12" were live on `main` at once, merged 22 minutes apart on 2026-09-05:
 * rep-kpi-reports.ts banded PM alone, and call-rate.ts banded an AM + PM SUM. Both were his own
 * words, days apart, and neither PR was wrong to read it the way it did. Asked directly, he
 * answered "8-12 pm only and 2 am accounts", and restated it unprompted the same day as "pm band
 * 8-12 and monthly cr target 10".
 *
 * THE CASE THAT SEPARATES THE TWO READINGS is the whole point of this file: a rep who logs
 * 7 PM and 2 AM verified calls in a working day. Summed that is 9 a day and reads IN-BAND; on PM
 * alone it is 7 and reads BELOW, which is the answer. It is not a corner case — measured on
 * production for August 2026 (Sat-Wed, 23 working days, 76 medical reps), the two readings gave a
 * DIFFERENT verdict for 31 reps, 29 of them in exactly this direction.
 *
 * WHY IT IS PINNED AT THREE LEVELS. The defect was never in the arithmetic — it was in which
 * population the arithmetic ran over, and every layer could reintroduce it independently:
 *
 *   1. the pure helpers, where an `am + pm` sum could come back;
 *   2. the board join, which is where the sum actually lived (kpis-board.ts fed the helper both
 *      slices); and
 *   3. the two standards modules, which is how they came to disagree in the first place — this
 *      file asserts they now hold the SAME numbers, so they cannot drift apart again silently.
 */
export function runPmCallRateBandTests() {
  // ── 1. The pure helpers ─────────────────────────────────────────────────────────────────────

  // THE SEPARATING CASE. 7 PM + 2 AM in one working day: only the 7 counts.
  assert.equal(pmVerifiedPerDay(7, 1), 7, "7 verified PM calls over one working day is 7 a day");
  assert.equal(
    pmCallRateBandOf(pmVerifiedPerDay(7, 1)),
    "below",
    "7 PM + 2 AM = 9 a day summed, which used to read in-band — on PM alone it is 7, which is BELOW the band",
  );

  // The same rep's AM work is real and is judged, just not here: 2 a day is exactly the AM target,
  // so this rep is simultaneously ON his AM standard and BELOW his PM band. That pair is the
  // owner's whole point — a good morning must not pay for an afternoon that did not happen.
  assert.equal(AM_CALL_RATE_TARGET, 2, "AM is a flat target, not a band");
  assert.equal(
    DEFAULT_REP_KPI_STANDARDS.AM.callRateBand,
    null,
    "AM has NO band at all — giving it one is the reading the owner ruled against",
  );

  // Both edges are inside the band, which is the nuance a bare target cannot express: at 8.0 the
  // rep MEETS the standard even though the target is 10.
  assert.equal(pmCallRateBandOf(8), "in-band", "8 is the band's own lower edge and counts as a pass");
  assert.equal(pmCallRateBandOf(7.999), "below", "just under 8 is below — the edge is inclusive, not approximate");
  assert.equal(pmCallRateBandOf(12), "in-band", "12 is the band's own upper edge and counts");
  assert.equal(pmCallRateBandOf(12.001), "above", "just over 12 is a volume flag, never a stronger pass");

  // Null is not zero. A rep with no working days has nothing to have fallen short of, and folding
  // that into "below" would accuse him of a shortfall the calendar invented.
  assert.equal(pmVerifiedPerDay(0, 0), null, "no working days gives null, not Infinity or NaN");
  assert.equal(pmCallRateBandOf(null), null, "a null rate has no band, and is never 'below'");

  // The helper takes ONE visit count. This is the structural guard: its predecessor took
  // (amVerified, pmVerified, workingDays) and summed the first two, so the bug was reachable by
  // passing the arguments the signature invited. There is now no argument an AM total fits into.
  assert.equal(
    pmVerifiedPerDay.length,
    2,
    "pmVerifiedPerDay takes (pmVerified, workingDays) — a third visit argument would let the AM+PM sum return",
  );

  // ── 2. The board join, which is where the sum actually lived ────────────────────────────────

  // A rep logging 7 PM and 2 AM verified on each of 5 working days: 35 PM, 10 AM. Summed that is
  // 45 / 5 = 9 a day (in-band under the retired reading); on PM alone it is 35 / 5 = 7 (below).
  const slice = (verified: number, target: number, workingDays: number) => ({
    attainmentPct: Math.round((verified / workingDays / target) * 100),
    campaign: 0,
    target,
    total: verified,
    totalRate: verified / workingDays,
    unverified: 0,
    verified,
    verifiedRate: verified / workingDays,
  });
  const sevenPmTwoAm: RepCallRate = {
    agentCrmId: 77,
    agentHrId: "a-77",
    agentName: "Seven PM Two AM",
    am: slice(10, AM_CALL_RATE_TARGET, 5),
    campaignOnlyDays: 0,
    campaignOverLimitDays: [],
    campaignShare: 0,
    pm: slice(35, PM_CALL_RATE_TARGET, 5),
    unspecified: 0,
    workingDays: 5,
  };

  const [row] = joinKpiRows({
    callRates: [sevenPmTwoAm],
    docLists: [],
    scope: { basis: "company", kind: "company", label: "Whole company" },
    workingDays: 5,
  });

  assert.equal(row.amVerified, 10, "the AM calls are still counted and still reported — they are simply not banded");
  assert.equal(row.pmVisitsPerDay, 7, "35 PM / 5 working days = 7 — the 10 AM calls are NOT in this figure");
  assert.notEqual(
    row.pmVisitsPerDay,
    9,
    "9 is (35 + 10) / 5, the summed reading the owner ruled against — reaching it means the sum came back",
  );
  assert.equal(
    row.pmCallRateBand,
    "below",
    "and so the board says BELOW, where the summed reading said in-band for the very same rep",
  );

  // The rep is on his AM standard at the same moment he is below his PM band. Both are true, and
  // the owner's locked rule is that they are reported apart and never merged into one verdict.
  assert.equal(row.amAttainmentPct, 100, "10 AM over 5 days is exactly the AM target of 2 a day");
  assert.equal(row.pmAttainmentPct, 70, "35 PM over 5 days is 7 against a target of 10");

  // What a manager actually filters on. The flag must follow the band, or the board offers a
  // filter that disagrees with the chip printed beside it.
  assert.ok(
    kpiFlagsOf(row).includes("below-pm-band"),
    "the rep is filterable as below the PM band — the flag and the chip must never disagree",
  );
  assert.ok(
    !kpiFlagsOf(row).includes("above-pm-band"),
    "and is not simultaneously flagged above it",
  );

  // ── 3. The two standards modules must hold the SAME numbers ─────────────────────────────────

  // This is the assertion that prevents a repeat. The original defect was two modules encoding
  // "8-12" against different populations, each internally consistent, disagreeing only on a
  // screen. Pinning them to one another means a future edit to either one goes red here.
  const pmBand = DEFAULT_REP_KPI_STANDARDS.PM.callRateBand;
  assert.ok(pmBand, "PM carries a band; it is the only list that does");
  assert.equal(pmBand.min, PM_CALL_RATE_BAND_MIN, "rep-kpi-reports.ts and call-rate.ts must agree on the lower edge");
  assert.equal(pmBand.max, PM_CALL_RATE_BAND_MAX, "and on the upper edge");
  assert.equal(
    DEFAULT_REP_KPI_STANDARDS.PM.callRatePerDay,
    PM_CALL_RATE_TARGET,
    "and on the target the band sits around — 10, which is the band's midpoint",
  );
  assert.equal(
    DEFAULT_REP_KPI_STANDARDS.AM.callRatePerDay,
    AM_CALL_RATE_TARGET,
    "AM keeps its own flat target of 2, judged apart",
  );
}

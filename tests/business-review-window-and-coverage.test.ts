import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  REVIEW_SOURCE_NOTICE,
  buildCoverage,
  gradedRowsOf,
} from "../src/lib/business-review/canonical.ts";
import {
  concentrationPeriods,
  describePeriods,
  figureWindowLabel,
  figureWindowPeriods,
  hasFigures,
} from "../src/lib/business-review/coverage.ts";
import {
  REVIEW_FLOOR,
  periodColumnLabel,
  resolveReviewWindow,
  type ReviewWindow,
} from "../src/lib/business-review/period.ts";
import { buildOverlays } from "../src/lib/business-review/sources/rollup.ts";
import type { AttributionMap, Placement } from "../src/lib/business-review/sources/attribution.ts";
import type { MarketingLoad } from "../src/lib/business-review/sources/marketing.ts";
import type { OutstationLoad } from "../src/lib/business-review/sources/outstation.ts";
import type {
  VisitAgentFact,
  VisitManagerFact,
  VisitsLoad,
} from "../src/lib/business-review/sources/visits.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { SALES_HISTORY_FLOOR } from "../src/lib/sales/vs-target.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Business Review — the window filter and the coverage gate.
 *
 * THE RULE THE WHOLE FILE DEFENDS, in the owner's words: "if this filter period will have no
 * data, flag that this period has no data, but never accept the filter and this period has no
 * data." This module is opened in front of a head of department. A month with no target rendering
 * as 0% achievement, or a month with no marketing requests rendering as 0 EGP spent, is not a
 * cosmetic defect there — it reads as an accusation that the person did nothing.
 *
 * The three facts this is written against are measured, not assumed (production, 2026-08-21):
 *   - 2026-03 .. 2026-06 hold ~10-12M EGP of real sales each and ZERO target rows. Achievement is
 *     uncomputable for them, and the old fixed-window page rendered 48.77% for "Jan-Jun" which was
 *     really January + February.
 *   - `marketing_requests` holds 15 rows in all of production, every one of them 2026-08 or later.
 *     Any window ending before August is a genuine "no data", never a zero.
 *   - `ireports360_visits` carries rows with no `agent_hr_id` at all — 2,509 in January alone.
 *     Those reach no rep, no area and no district, and must be COUNTED and reported rather than
 *     quietly dropped so the totals look tidy.
 *   - 2026-08 has exactly ONE validated Source-of-Sales batch and its distributor code is
 *     `DirectReq` — the pseudo-distributor the Direct Orders module writes approved orders under,
 *     one at a time, all month. So August holds 674 rows and 321,916 EGP against a 17,508,935 EGP
 *     target, and no distributor file at all. Graded, it reads as 1.8%; left inside the DEFAULT
 *     Jan-Aug window it pulls the whole review from 50.7% to 39.3%.
 */

// ── fixtures ─────────────────────────────────────────────────────────────────

const AVAILABLE = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

function windowOf(from: string, to: string): ReviewWindow {
  return resolveReviewWindow(from, to, AVAILABLE).window;
}

function salesRow(partial: Partial<AchievementRow> & { period: string }): AchievementRow {
  return {
    lineCode: "pedia",
    regionCode: "R1",
    areaCode: "A1",
    areaState: null,
    isOther: false,
    repSeatId: "seat-rep-1",
    repHrId: "HR-REP-1",
    dmSeatId: "seat-dm-1",
    dmHrId: "HR-DM-1",
    productCode: "P1",
    actualUnits: 10,
    actualValue: 1000,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...partial,
  };
}

/** Source text, for the pins that guard wiring a unit test cannot reach. */
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Collapse whitespace runs so a reformat or a line-wrap cannot false-fail a source check. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const NO_MARKETING: MarketingLoad = { facts: [], periodsWithData: [], totalRows: 0 };
const NO_OUTSTATION: OutstationLoad = { facts: [], periodsWithData: [], totalRows: 0 };
const NO_VISITS: VisitsLoad = {
  agents: [], managers: [], activity: [], periodsWithData: [],
  totalRows: 0, collapsedRows: 0, unattributableRows: 0, excludedAgentRows: 0,
};
/** Every month in the window has a real distributor upload. That is the ordinary case, and what
 *  every block assumes unless it is the one testing the not-yet-uploaded gate. */
const UPLOADED = (w: ReviewWindow) => new Set(w.periods);

const NO_UNPLACED = {
  marketingRequests: 0, marketingCommitted: 0,
  outstationRows: 0, outstationClaimed: 0,
  visitRows: 0, visitAgents: 0, liveTreePlacedFacts: 0,
};

/** A placement table keyed exactly the way the real one is: (person, month). Anyone absent is
 *  unplaceable, which is the case the rollup has to survive without dropping their rows. */
function attributionOf(table: Record<string, Partial<Placement>>): AttributionMap {
  return {
    place: (hrId, period) => {
      const hit = table[`${String(hrId ?? "").toUpperCase()}|${period}`];
      if (!hit) return null;
      return {
        areaCode: null, dmSeatId: null, dmHrId: null, lineCode: null, regionCode: null,
        placedFromLiveTree: false,
        ...hit,
      };
    },
    liveTreeOnlyHrIds: new Set<string>(),
    unplaceableHrIds: new Set<string>(),
  };
}

function agentFact(partial: Partial<VisitAgentFact> & { period: string; agentHrId: string }): VisitAgentFact {
  return {
    agentCrmId: null,
    agentName: null,
    fieldVisits: 0,
    regularVisits: 0,
    campaignVisits: 0,
    adminRows: 0,
    accompaniedVisits: 0,
    // Default the split to "all PM", which is what visitCountBucket answers for an unmarked period
    // and a contact with no speciality — so a fixture that says nothing about buckets still adds up.
    visitSplit: { am: 0, pm: partial.fieldVisits ?? 0, pharmacies: 0 },
    customers: new Set<number>(),
    customersAm: new Set<number>(),
    customersPm: new Set<number>(partial.customers ?? []),
    customersPharmacy: new Set<number>(),
    // The list's make-up. Default it to one unnamed bucket carrying this fixture's own visits and
    // customers, which is what the reader answers for a contact the vendor gave no speciality —
    // so a fixture that says nothing about specialties still adds up to the same totals.
    specialityContacts: new Map<string, Set<number>>([["", new Set<number>(partial.customers ?? [])]]),
    specialityVisits: new Map<string, number>([["", partial.fieldVisits ?? 0]]),
    byLabel: new Map<string, number>(),
    ...partial,
  };
}

/**
 * A manager's visit fact. A helper rather than two object literals, because a literal is what made
 * this file go red in CI when the three-way split landed — `agentFact` absorbed the new fields in
 * one place and the two manager rows did not.
 */
function managerFact(
  partial: Partial<VisitManagerFact> & { period: string; managerHrId: string },
): VisitManagerFact {
  return {
    managerName: null,
    rides: 0,
    ridesByRep: new Map<string, number>(),
    customers: new Set<number>(),
    // Same default as `agentFact`: an unmarked period and a contact with no speciality bucket to
    // PM, so a fixture that says nothing about buckets still adds up.
    customersAm: new Set<number>(),
    customersPm: new Set<number>(partial.customers ?? []),
    customersPharmacy: new Set<number>(),
    rideSplit: { am: 0, pm: partial.rides ?? 0, pharmacies: 0 },
    ...partial,
  };
}

// ── the tests ────────────────────────────────────────────────────────────────

export async function runBusinessReviewWindowAndCoverageTests() {
  // ---------------------------------------------------------------- 1. window
  // Every branch below is a CLAMP, and every clamp has to announce itself. Silently answering a
  // different question than the one asked is the single failure this module cannot survive: the
  // page would show six honest months under a heading naming a window it never read.
  {
    const full = resolveReviewWindow(null, null, AVAILABLE);
    assert.deepEqual([full.window.from, full.window.to], ["2026-01", "2026-08"], "no params = everything");
    assert.equal(full.adjustment, null, "an unrestricted request was not adjusted");
    assert.deepEqual(full.window.periods, AVAILABLE, "periods are the inclusive months, ascending");
    assert.equal(full.window.label, "Jan – Aug 2026");

    // Month keys round-trip: what the filter emits is exactly what the month records are keyed on.
    const mid = resolveReviewWindow("2026-03", "2026-05", AVAILABLE);
    assert.deepEqual(mid.window.periods, ["2026-03", "2026-04", "2026-05"]);
    assert.equal(mid.adjustment, null);
    assert.deepEqual(
      mid.window.periods.map((p) => periodColumnLabel(p, mid.window.periods)),
      ["Mar", "Apr", "May"],
      "a single-year window prints bare month names",
    );

    // Reversed bounds: swapped, and SAID so.
    const reversed = resolveReviewWindow("2026-06", "2026-02", AVAILABLE);
    assert.deepEqual([reversed.window.from, reversed.window.to], ["2026-02", "2026-06"]);
    assert.match(reversed.adjustment ?? "", /swapped/, "a swap must be reported, not silent");

    // Before the floor and after the ceiling: pulled in, and SAID so.
    const outside = resolveReviewWindow("2025-04", "2027-01", AVAILABLE);
    assert.deepEqual([outside.window.from, outside.window.to], ["2026-01", "2026-08"]);
    assert.match(outside.adjustment ?? "", /data starts at Jan 2026/);
    assert.match(outside.adjustment ?? "", /data ends at Aug 2026/);

    // Garbage is named back to the reader rather than swallowed.
    const junk = resolveReviewWindow("2026-13", "june", AVAILABLE);
    assert.match(junk.adjustment ?? "", /"2026-13" is not a month/);
    assert.match(junk.adjustment ?? "", /"june" is not a month/);
    assert.deepEqual([junk.window.from, junk.window.to], ["2026-01", "2026-08"], "and it still renders");

    // One bound alone means that ONE month, not "from here to forever".
    const single = resolveReviewWindow(null, "2026-04", AVAILABLE);
    assert.deepEqual(single.window.periods, ["2026-04"]);
    assert.equal(single.adjustment, null);
    assert.equal(single.window.label, "Apr 2026");

    // A window that spans a year boundary must stay unambiguous in a column header.
    const across = resolveReviewWindow("2025-12", "2026-02", ["2025-12", "2026-01", "2026-02"]);
    assert.deepEqual(
      across.window.periods.map((p) => periodColumnLabel(p, across.window.periods)),
      ["Dec 2025", "Jan 2026", "Feb 2026"],
      "a cross-year window must carry the year in every column",
    );
  }

  // ------------------------------------------------- 2. no targets = NOT ZERO
  // The finding this module was rebuilt for. Mar-Jun hold real sales and no targets at all.
  {
    const window = windowOf("2026-03", "2026-06");
    const rows = window.periods.map((period) => salesRow({ period, actualValue: 10_000_000 }));
    const coverage = buildCoverage({
      window, rows, uploaded: UPLOADED(window),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });

    const sales = coverage.sources.find((s) => s.source === "sales");
    const targets = coverage.sources.find((s) => s.source === "targets");
    assert.equal(sales?.status, "complete", "the sales half of these months is real and complete");
    assert.equal(targets?.status, "empty", "no target row exists in any month of the window");
    assert.equal(coverage.ungradeable, true, "so nothing in this window can be graded");
    assert.equal(coverage.empty, false, "but the window is NOT empty — it holds 40M EGP of sales");
    assert.equal(hasFigures(coverage, "targets"), false, "achievement must render as text, not a number");
    assert.equal(hasFigures(coverage, "sales"), true, "sales must still render as numbers");
    assert.match(targets?.note ?? "", /not gradeable/, "the reader is told WHY, in words");
    assert.match(targets?.note ?? "", /cannot be computed/);
    assert.ok(coverage.emptySources.includes("targets"));

    // One target anywhere flips the window to partial — and partial is gradeable, on the months
    // that have one. This is the January/February half of the old fixed page.
    const janToJun = windowOf("2026-01", "2026-06");
    const withJan = buildCoverage({
      window: janToJun,
      uploaded: UPLOADED(janToJun),
      rows: [
        salesRow({ period: "2026-01", hasTarget: true, targetValue: 5_000_000 }),
        ...["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map((period) => salesRow({ period })),
      ],
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });
    const partialTargets = withJan.sources.find((s) => s.source === "targets");
    assert.equal(partialTargets?.status, "partial");
    assert.equal(withJan.ungradeable, false);
    assert.deepEqual(partialTargets?.periodsWithData, ["2026-01"]);
    assert.deepEqual(
      partialTargets?.periodsWithoutData,
      ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
      "and the five ungraded months are named, so the percentage cannot be read as covering them",
    );
    assert.match(partialTargets?.note ?? "", /are not zeros/);
  }

  // ------------------------------------------- 3. an empty source is not a 0
  {
    const window = windowOf("2026-01", "2026-06");
    // Fully graded sales, so this block isolates ONE empty source rather than several.
    const rows = window.periods.map((period) => salesRow({ period, hasTarget: true, targetValue: 900_000 }));
    const coverage = buildCoverage({
      window, rows, uploaded: UPLOADED(window),
      marketing: NO_MARKETING,       // production truth: no request predates 2026-08
      outstation: NO_OUTSTATION,
      visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });

    const marketing = coverage.sources.find((s) => s.source === "marketing");
    assert.equal(marketing?.status, "empty");
    assert.equal(hasFigures(coverage, "marketing"), false, "the spend tile must print 'no data'");
    assert.match(marketing?.note ?? "", /This is not a zero/, "the exact distinction, spelled out");
    assert.equal(marketing?.rows, 0);
    assert.deepEqual(coverage.emptySources.sort(), ["customers", "marketing", "outstation", "visits"]);

    // Coverage still knows where each figure would have come from, so the Sources tab can be read
    // as a check on the module rather than as a description of it.
    for (const source of coverage.sources) {
      assert.ok(source.origin.length > 0, `${source.source} names its origin`);
      assert.ok(source.rule.length > 0, `${source.source} names its inclusion rule`);
    }
  }

  // ---------------------------------------- 4. one live month = PARTIAL, named
  {
    const window = windowOf("2026-01", "2026-08");
    const rows = window.periods.map((period) => salesRow({ period }));
    const coverage = buildCoverage({
      window, rows, uploaded: UPLOADED(window),
      marketing: { facts: [], periodsWithData: ["2026-08"], totalRows: 15 },
      outstation: NO_OUTSTATION, visits: NO_VISITS, unplaced: NO_UNPLACED, adjustment: null,
    });
    const marketing = coverage.sources.find((s) => s.source === "marketing");
    assert.equal(marketing?.status, "partial");
    assert.equal(hasFigures(coverage, "marketing"), true, "August's 5,500 EGP is a real number");
    assert.deepEqual(marketing?.periodsWithData, ["2026-08"]);
    assert.equal(marketing?.periodsWithoutData.length, 7);
    assert.match(marketing?.note ?? "", /Jan 2026 through Jul 2026 \(7 months\)/);
    assert.ok(coverage.partialSources.includes("marketing"));
  }

  // ------------------------------------------ 5. no sales at all = HARD EMPTY
  // The state the owner asked for by name: never accept the filter and show nothing.
  {
    const window = windowOf("2026-07", "2026-08");
    const coverage = buildCoverage({
      window, rows: [], uploaded: UPLOADED(window),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: "data ends at Aug 2026, so the window was pulled back",
    });
    assert.equal(coverage.empty, true, "the page must render the hard empty state and no tables");
    assert.equal(coverage.ungradeable, true);
    assert.equal(hasFigures(coverage, "sales"), false);
    assert.equal(
      coverage.adjustment,
      "data ends at Aug 2026, so the window was pulled back",
      "and the clamp that produced this window travels with it",
    );
  }

  // ------------------------------- 6. unattributable rows are COUNTED, not cut
  {
    const window = windowOf("2026-01", "2026-01");
    const coverage = buildCoverage({
      window,
      uploaded: UPLOADED(window),
      rows: [salesRow({ period: "2026-01" })],
      marketing: NO_MARKETING,
      outstation: NO_OUTSTATION,
      visits: { ...NO_VISITS, periodsWithData: ["2026-01"], totalRows: 9151, unattributableRows: 2509 },
      unplaced: { ...NO_UNPLACED, marketingRequests: 3, outstationRows: 2 },
      adjustment: null,
    });
    const visits = coverage.sources.find((s) => s.source === "visits");
    assert.equal(visits?.unattributedRows, 2509, "January's headless rows are on the record");
    assert.match(visits?.unattributedNote ?? "", /reach no rep, area or district/);
    assert.match(visits?.unattributedNote ?? "", /counted here and in no territory total/);
    assert.equal(coverage.sources.find((s) => s.source === "marketing")?.unattributedRows, 3);
    assert.equal(coverage.sources.find((s) => s.source === "outstation")?.unattributedRows, 2);
  }

  // ------------------------------------- 7. no ellipsis, ever (standing rule)
  {
    assert.equal(describePeriods([]), "");
    assert.equal(describePeriods(["2026-04"]), "Apr 2026");
    assert.equal(describePeriods(["2026-04", "2026-05"]), "Apr 2026 and May 2026");
    assert.equal(describePeriods(["2026-04", "2026-05", "2026-06"]), "Apr 2026, May 2026 and Jun 2026");
    const long = describePeriods(AVAILABLE);
    assert.equal(long, "Jan 2026 through Aug 2026 (8 months)");
    for (const sample of [describePeriods(["2026-01", "2026-02", "2026-03"]), long]) {
      assert.ok(!sample.includes("…") && !sample.includes("..."), `no ellipsis in "${sample}"`);
    }
  }

  // ------------------------- 8. customers are UNIONED at every level, never summed
  {
    const window = windowOf("2026-04", "2026-05");
    const attribution = attributionOf({
      // Two reps in the SAME area, plus one on another line, all placed for both months.
      "HR-A|2026-04": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" },
      "HR-A|2026-05": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" },
      "HR-B|2026-04": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" },
      "HR-B|2026-05": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" },
      "HR-C|2026-04": { areaCode: "A9", dmSeatId: "DM9", lineCode: "cns" },
    });

    const overlays = buildOverlays({
      window,
      // Every month of these fixtures carries sales, so the figure window is the whole window.
      figurePeriods: new Set(window.periods),
      rows: [],
      attribution,
      marketing: NO_MARKETING,
      outstation: NO_OUTSTATION,
      visits: {
        ...NO_VISITS,
        periodsWithData: ["2026-04", "2026-05"],
        agents: [
          // Doctors 1 and 2 are seen by BOTH reps in area A1 — that is two reps, one doctor each.
          agentFact({ period: "2026-04", agentHrId: "HR-A", fieldVisits: 10, regularVisits: 10, customers: new Set([1, 2, 3]) }),
          agentFact({ period: "2026-04", agentHrId: "HR-B", fieldVisits: 6, regularVisits: 6, customers: new Set([2, 3, 4]) }),
          // May adds one genuinely new doctor (5) and repeats three of April's.
          agentFact({ period: "2026-05", agentHrId: "HR-A", fieldVisits: 8, regularVisits: 8, customers: new Set([1, 2, 5]) }),
          // Doctor 3 is ALSO covered by the CNS line — a cross-line doctor, counted once company-wide.
          agentFact({ period: "2026-04", agentHrId: "HR-C", fieldVisits: 4, regularVisits: 4, customers: new Set([3, 7]) }),
        ],
      },
    });

    const area = overlays.area("pedia", "A1");
    const pedia = overlays.line("pedia");
    const cns = overlays.line("cns");
    const company = overlays.company;

    // Area: the naive sum of the three agent facts is 3+3+3 = 9; the union is {1,2,3,4,5} = 5.
    assert.equal(area.customersTotal, 5, "two reps on the same doctor is ONE doctor");
    assert.ok(area.customersTotal < 9, "the union must be strictly below the naive sum");
    assert.deepEqual(area.customersByMonth, { "2026-04": 4, "2026-05": 3 }, "each month is its own union");
    assert.ok(
      area.customersTotal < area.customersByMonth["2026-04"] + area.customersByMonth["2026-05"],
      "and the window total is not the sum of the months either",
    );
    assert.ok(
      area.customersTotal >= Math.max(area.customersByMonth["2026-04"], area.customersByMonth["2026-05"]),
      "nor is it smaller than its largest month",
    );

    // Company: pedia {1,2,3,4,5} + cns {3,7} = 7 naive, 6 unioned — doctor 3 is on both lines.
    assert.equal(pedia.customersTotal, 5);
    assert.equal(cns.customersTotal, 2);
    assert.equal(company.customersTotal, 6, "a doctor covered by two lines is one doctor company-wide");
    assert.equal(company.customersTotal, pedia.customersTotal + cns.customersTotal - 1);

    // Visits, by contrast, ARE additive — the two rules must not be confused for one another.
    assert.equal(area.visits, 24);
    assert.equal(company.visits, 28);
    assert.equal(area.visitingReps, 2, "distinct reps, not visit rows");
    assert.equal(overlays.dm("DM1").customersTotal, 5, "a district unions its areas the same way");
  }

  // -------------- 9. a fact nobody can place still reaches the company total
  // The other half of "never silent-drop a row": it is counted at the top, reported in `unplaced`,
  // and lands on no territory — so no manager is charged for it and no total loses it.
  {
    const window = windowOf("2026-02", "2026-02");
    const attribution = attributionOf({ "HR-KNOWN|2026-02": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" } });

    const overlays = buildOverlays({
      window,
      // Every month of these fixtures carries sales, so the figure window is the whole window.
      figurePeriods: new Set(window.periods),
      rows: [],
      attribution,
      marketing: {
        periodsWithData: ["2026-02"], totalRows: 2,
        facts: [
          { period: "2026-02", requesterHrId: "HR-KNOWN", lineId: 1, areaId: 1, status: "approved", bucket: "committed", cost: 5500 },
          { period: "2026-02", requesterHrId: "HR-GHOST", lineId: null, areaId: null, status: "approved", bucket: "committed", cost: 1000 },
        ],
      },
      outstation: {
        periodsWithData: ["2026-02"], totalRows: 2,
        facts: [
          { period: "2026-02", hrId: "HR-KNOWN", claimed: 900, approved: 0, rejected: false, travel: 900, meeting: 0, allowance: 0, other: 0 },
          { period: "2026-02", hrId: "HR-GHOST", claimed: 37, approved: 37, rejected: false, travel: 0, meeting: 37, allowance: 0, other: 0 },
        ],
      },
      visits: {
        ...NO_VISITS,
        periodsWithData: ["2026-02"],
        agents: [
          agentFact({ period: "2026-02", agentHrId: "HR-KNOWN", fieldVisits: 12, regularVisits: 12, customers: new Set([1, 2]) }),
          agentFact({ period: "2026-02", agentHrId: "HR-GHOST", fieldVisits: 5, regularVisits: 5, adminRows: 2, customers: new Set([9]) }),
        ],
      },
    });

    const area = overlays.area("pedia", "A1");
    const company = overlays.company;

    assert.equal(area.marketingCommitted, 5500, "the district is charged only what it can be charged");
    assert.equal(company.marketingCommitted, 6500, "but the company total keeps the orphan");
    assert.equal(overlays.unplaced.marketingRequests, 1);
    assert.equal(overlays.unplaced.marketingCommitted, 1000);

    assert.equal(area.outstationClaimed, 900);
    assert.equal(company.outstationClaimed, 937);
    assert.equal(overlays.unplaced.outstationRows, 1);
    assert.equal(overlays.unplaced.outstationClaimed, 37);

    assert.equal(area.visits, 12);
    assert.equal(company.visits, 17);
    assert.equal(overlays.unplaced.visitRows, 7, "field rows AND admin rows, both counted");
    assert.equal(overlays.unplaced.visitAgents, 1);
    assert.equal(company.customersTotal, 3, "the orphan's doctor is a real doctor");
    assert.equal(area.customersTotal, 2);

    // Nothing reached a line, because the ghost has no line — the line total is below the company
    // total by exactly the orphan, and that difference is explained by `unplaced`, not hidden.
    assert.equal(overlays.line("pedia").visits, 12);
  }

  // ---------------- 10. a ride is counted where the REP stood, not the manager
  // Otherwise a Training Manager's 404 rides land on whichever line today's tree seats them on,
  // and the line totals stop adding up to the company total.
  {
    const window = windowOf("2026-06", "2026-06");
    const attribution = attributionOf({
      "HR-REP|2026-06": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" },
    });

    const overlays = buildOverlays({
      window,
      // Every month of these fixtures carries sales, so the figure window is the whole window.
      figurePeriods: new Set(window.periods),
      rows: [salesRow({ period: "2026-06", dmHrId: "HR-DM", dmSeatId: "DM1" })],
      attribution,
      marketing: NO_MARKETING,
      outstation: NO_OUTSTATION,
      visits: {
        ...NO_VISITS,
        periodsWithData: ["2026-06"],
        agents: [
          agentFact({ period: "2026-06", agentHrId: "HR-REP", fieldVisits: 20, regularVisits: 20, accompaniedVisits: 6 }),
        ],
        managers: [
          managerFact({ period: "2026-06", managerHrId: "HR-DM", managerName: "DM", rides: 6, ridesByRep: new Map([["HR-REP", 6]]) }),
          // A manager with no DM seat in the sales rows contributes no phantom district.
          managerFact({ period: "2026-06", managerHrId: "HR-TRAINING", managerName: "TM", rides: 44 }),
        ],
      },
    });

    assert.equal(overlays.area("pedia", "A1").doubleVisits, 6, "rides received, where the rep stood");
    assert.equal(overlays.line("pedia").doubleVisits, 6, "so the line total is the sum of its areas");
    assert.equal(overlays.company.doubleVisits, 6, "and the company total is not double-counted");
    assert.equal(overlays.dm("DM1").ridesLed, 6, "rides DELIVERED sit on the district that led them");
    assert.equal(overlays.area("pedia", "A1").ridesLed, 0, "and nowhere else");
    assert.equal(overlays.company.ridesLed, 0, "least of all the company row, which would double it");
  }

  // -------------- 11. a month with rows but NO distributor upload is held OUT
  //
  // The defect this block exists for was live in the DEFAULT view. August 2026 carries one
  // validated Source-of-Sales batch whose distributor code is `DirectReq` — approved Direct
  // orders, which trickle in one at a time all month — and not one real distributor file. The
  // engine still returns August's rows against August's whole 17,508,935 EGP target, so a
  // Jan-Aug review graded 39.3% when the seven months that HAVE landed grade 50.7%.
  //
  // Nothing on the page explained the eleven points. The Coverage tab even promised "those months
  // contribute no sales", which was untrue: they contributed the denominator and almost none of
  // the numerator.
  {
    const window = windowOf("2026-01", "2026-08");
    const landed = window.periods.filter((p) => p !== "2026-08");
    const rows = [
      ...landed.map((period) => salesRow({ period, actualValue: 10_000_000, hasTarget: true, targetValue: 20_000_000 })),
      // August, as production actually holds it: real value, real target, no distributor file.
      salesRow({ period: "2026-08", actualValue: 321_916.47, hasTarget: true, targetValue: 17_508_935.49 }),
    ];
    const coverage = buildCoverage({
      window, rows,
      uploaded: new Set(landed),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });

    assert.ok(coverage.notUploaded, "the window must declare that one of its months has not landed");
    assert.deepEqual(coverage.notUploaded?.periods, ["2026-08"], "and name it, not just count it");
    assert.equal(
      coverage.notUploaded?.value,
      321_916.47,
      "carrying the value it DOES hold — holding a month out silently is the same lie inverted",
    );
    assert.equal(coverage.notUploaded?.rows, 1);

    const sales = coverage.sources.find((s) => s.source === "sales");
    assert.equal(sales?.status, "partial", "sales coverage follows the upload ledger, not the row count");
    assert.deepEqual(sales?.periodsWithData, landed, "the seven months that landed are the graded ones");
    assert.deepEqual(sales?.periodsWithoutData, ["2026-08"]);
    assert.equal(sales?.rows, 7, "and the held-out row is not counted as a sales row");
    assert.match(sales?.note ?? "", /have not arrived yet/, "the note says WHY August is missing");
    assert.match(sales?.note ?? "", /only Direct orders/, "and what it does hold, in the owner's words");
    assert.match(sales?.note ?? "", /EGP 321,916/, "with the figure, so the exclusion hides nothing");
    assert.match(
      sales?.note ?? "",
      /collapse that has not happened/,
      "and the consequence of getting this wrong, which is the whole reason for the gate",
    );

    // Targets are NOT flagged. August's targets really are loaded; saying they are missing would
    // send somebody to load a thing that is already there.
    const targets = coverage.sources.find((s) => s.source === "targets");
    assert.equal(targets?.status, "complete", "every month in this window has targets, August included");
    assert.ok(
      !coverage.emptySources.includes("targets"),
      "the not-uploaded gate must not masquerade as a missing-target gate",
    );

    // A window that is ENTIRELY not-uploaded is the hard empty state, not a 1.8% month.
    const augustOnly = windowOf("2026-08", "2026-08");
    const alone = buildCoverage({
      window: augustOnly,
      rows: [salesRow({ period: "2026-08", actualValue: 321_916.47, hasTarget: true, targetValue: 17_508_935.49 })],
      uploaded: new Set<string>(),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });
    assert.equal(alone.empty, true, "August on its own renders the hard empty state, never 1.8%");
    assert.equal(hasFigures(alone, "sales"), false, "so no sales figure may be printed as a number");
    assert.ok(alone.notUploaded, "and it still says why, rather than looking like a month that sold nothing");

    // The ordinary case stays ordinary: nothing is flagged when every month has landed.
    const clean = buildCoverage({
      window, rows, uploaded: UPLOADED(window),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });
    assert.equal(clean.notUploaded, null, "a fully uploaded window carries no not-uploaded block");
    assert.equal(clean.sources.find((s) => s.source === "sales")?.status, "complete");
    assert.equal(clean.sources.find((s) => s.source === "sales")?.rows, 8, "and every row is graded");
  }

  // ------------- 12. the eleven points, in arithmetic rather than in prose
  //
  // Block 11 proves the window SAYS August has not landed. This one proves holding it out changes
  // the number, using the figures au.f_monthly_achievement actually returned for production on
  // 2026-08-22. If someone ever "simplifies" gradedRowsOf back to `rows`, the default review
  // silently drops eleven points again and this is what stops it.
  {
    const window = windowOf("2026-01", "2026-08");
    // covered actual and target per month, straight from the production census.
    const CENSUS: Record<string, { covered: number; target: number }> = {
      "2026-01": { covered: 8_476_247.66, target: 24_565_478.92 },
      "2026-02": { covered: 10_841_071.69, target: 15_042_173.73 },
      "2026-03": { covered: 0, target: 0 },  // no targets loaded at all
      "2026-04": { covered: 0, target: 0 },
      "2026-05": { covered: 0, target: 0 },
      "2026-06": { covered: 0, target: 0 },
      "2026-07": { covered: 10_198_714.78, target: 18_648_207.17 },
      "2026-08": { covered: 258_858.67, target: 17_508_935.49 },  // one DirectReq batch
    };
    const rows = window.periods.map((period) =>
      salesRow({
        period,
        actualValue: CENSUS[period].covered,
        hasTarget: CENSUS[period].target > 0,
        targetValue: CENSUS[period].target > 0 ? CENSUS[period].target : null,
      }),
    );
    const achievementOf = (subset: readonly AchievementRow[]) => {
      const covered = subset.filter((r) => r.hasTarget).reduce((s, r) => s + r.actualValue, 0);
      const target = subset.reduce((s, r) => s + (r.targetValue ?? 0), 0);
      return target === 0 ? null : covered / target;
    };

    const landed = new Set(window.periods.filter((p) => p !== "2026-08"));
    const graded = gradedRowsOf(rows, landed);

    assert.equal(graded.length, 7, "August drops out of the graded set");
    assert.ok(!graded.some((r) => r.period === "2026-08"), "and it is August that drops, not a bystander");

    const withAugust = achievementOf(rows) ?? 0;
    const withoutAugust = achievementOf(graded) ?? 0;
    assert.equal(Math.round(withAugust * 10_000) / 100, 39.3, "grading the un-landed month reads 39.30%");
    assert.equal(Math.round(withoutAugust * 10_000) / 100, 50.67, "the seven months that landed read 50.67%");
    assert.ok(
      withoutAugust - withAugust > 0.11,
      "eleven points — the size of the hole a manager would have been asked to explain",
    );

    // And the ordinary case is untouched: nothing is held out when every month has landed.
    assert.equal(gradedRowsOf(rows, UPLOADED(window)).length, 8);
    assert.equal(gradedRowsOf(rows, new Set<string>()).length, 0, "and nothing survives an empty ledger");
  }

  // -------------------------------------------- 6. the review opens on July 2026
  // Owner's decision, 2026-08-23. The review must not open on a month it cannot grade.
  //
  // This block exists because REVIEW_FLOOR USED to be `= SALES_HISTORY_FLOOR`, and the comment
  // above it actively invited a reader to keep the two identical ("not a second, drifting
  // constant"). Re-aliasing them would silently reopen the review on January without touching a
  // single line of window logic, so pin BOTH halves: the value, and the divergence.
  {
    assert.equal(REVIEW_FLOOR, "2026-07", "the Business Review opens on July 2026");
    assert.notEqual(
      REVIEW_FLOOR,
      SALES_HISTORY_FLOOR,
      "the review floor is deliberately LATER than the engine floor - do not re-alias them",
    );
    assert.equal(
      SALES_HISTORY_FLOOR,
      "2026-01",
      "and the engine floor must NOT be dragged forward instead: the employee portal, " +
        "employee-360 and the sales dashboard all share it",
    );

    // availableReviewPeriods() filters the closing list with exactly `p >= REVIEW_FLOOR`, so a
    // ledger that still holds the spring months must offer none of them to the picker.
    const closings = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
    const offered = closings.filter((period) => period >= REVIEW_FLOOR);
    assert.deepEqual(offered, ["2026-07", "2026-08"], "only July onward reaches the filter");
    assert.ok(
      !offered.some((period) => period >= "2026-03" && period <= "2026-06"),
      "March-June carry no targets at all, so they must never be selectable",
    );

    // A bookmarked pre-July URL still renders, clamped forward, and SAYS what it did.
    const bookmarked = resolveReviewWindow("2026-02", "2026-08", offered);
    assert.deepEqual([bookmarked.window.from, bookmarked.window.to], ["2026-07", "2026-08"]);
    assert.match(
      bookmarked.adjustment ?? "",
      /data starts at Jul 2026/,
      "a clamped window must announce itself rather than answer a different question",
    );
  }

  // -------------------------------------------- 7. the notice cannot outlive the floor
  // The banner used to end with "H1 2026 incentives were paid against the retired sales engine
  // and are closed; some bands here differ from what was actually paid." The moment REVIEW_FLOOR
  // moved to July 2026 that sentence became unreachable - the picker cannot offer an H1 month, so
  // the module was warning a head of department about months it refuses to render.
  //
  // Pin the INVARIANT, not the sentence: the label must never name a period below the floor,
  // otherwise the next floor move strands it again in exactly the same way.
  {
    assert.doesNotMatch(
      REVIEW_SOURCE_NOTICE,
      /\b(H1|S1|Semester 1|Jan|Feb|Mar|Apr|May|Jun)\b/i,
      "the review notice names a period below REVIEW_FLOOR that the picker cannot offer",
    );
    assert.match(
      REVIEW_SOURCE_NOTICE,
      /not a payout record/i,
      "the one thing the notice exists to say must survive every rewording",
    );
    assert.match(
      REVIEW_SOURCE_NOTICE,
      /Monthly Closing/,
      "and it must still name the engine the review was rebuilt from",
    );
  }

  // ─────────── ONE SPAN FOR EVERY FIGURE (owner ruling 2026-09-26) ───────────
  //
  // The sales half has always held a month with no distributor upload out of every sales, target and
  // achievement figure. The non-sales half did not, so one heading covered two different spans: on
  // production's default Jul–Sep 2026 window, sales were Jul+Aug while 48.8% of committed marketing,
  // 41.8% of outstation and 24.2% of field visits came from September. The coverage note listed
  // exactly what had been held out of the SALES — which is what made the silence about the rest read
  // as deliberate rather than as an oversight.
  {
    const window = windowOf("2026-07", "2026-08");
    // July's distributor files landed; August holds Direct orders only.
    const figurePeriods = new Set(["2026-07"]);
    const attribution = attributionOf({
      "HR-REP|2026-07": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" },
      "HR-REP|2026-08": { areaCode: "A1", dmSeatId: "DM1", lineCode: "pedia" },
    });

    const overlays = buildOverlays({
      window,
      figurePeriods,
      rows: [],
      attribution,
      marketing: {
        periodsWithData: ["2026-07", "2026-08"], totalRows: 2,
        facts: [
          { period: "2026-07", requesterHrId: "HR-REP", lineId: 1, areaId: 1, status: "approved", bucket: "committed", cost: 1_000 },
          { period: "2026-08", requesterHrId: "HR-REP", lineId: 1, areaId: 1, status: "approved", bucket: "committed", cost: 9_000 },
        ],
      },
      outstation: {
        periodsWithData: ["2026-08"], totalRows: 1,
        facts: [
          { period: "2026-08", hrId: "HR-REP", claimed: 700, approved: 700, rejected: false, travel: 700, meeting: 0, allowance: 0, other: 0 },
        ],
      },
      visits: {
        ...NO_VISITS,
        periodsWithData: ["2026-07", "2026-08"],
        agents: [
          agentFact({ period: "2026-07", agentHrId: "HR-REP", fieldVisits: 4, regularVisits: 4, customers: new Set([1]) }),
          agentFact({ period: "2026-08", agentHrId: "HR-REP", fieldVisits: 40, regularVisits: 40, customers: new Set([2, 3]) }),
        ],
      },
    });

    assert.equal(
      overlays.company.marketingCommitted,
      1_000,
      "August's 9,000 EGP of committed marketing must not sit beside sales that stop in July",
    );
    assert.equal(overlays.company.outstationClaimed, 0, "nor August's outstation claim");
    assert.equal(overlays.company.visits, 4, "nor August's 40 field visits");
    assert.equal(overlays.company.customersTotal, 1, "nor the doctors only August saw");
    assert.equal(
      overlays.area("pedia", "A1").marketingCommitted,
      1_000,
      "and the same cut applies at every grain, not only the company total",
    );

    // Held out is not dropped. Every excluded fact is counted, by source, and named in words.
    assert.deepEqual(overlays.heldOut.periods, ["2026-08"]);
    assert.equal(overlays.heldOut.marketingCommitted, 9_000);
    assert.equal(overlays.heldOut.marketingRequests, 1);
    assert.equal(overlays.heldOut.outstationClaimed, 700);
    assert.equal(overlays.heldOut.outstationRows, 1);
    assert.equal(overlays.heldOut.visitRows, 40);
    assert.equal(overlays.heldOut.visitAgents, 1);

    const coverage = buildCoverage({
      window,
      rows: [salesRow({ period: "2026-07", targetValue: 10, actualValue: 10, hasTarget: true })],
      uploaded: figurePeriods,
      marketing: NO_MARKETING,
      outstation: NO_OUTSTATION,
      visits: NO_VISITS,
      unplaced: overlays.unplaced,
      heldOut: overlays.heldOut,
      figureWindow: { label: "Jul 2026", periods: ["2026-07"] },
      adjustment: null,
    });

    const note = coverage.notUploaded?.note ?? "";
    assert.match(note, /9,000/, "the note must name the marketing that was held out, in EGP");
    assert.match(note, /700/, "and the outstation");
    assert.match(note, /40 CRM rows/, "and the visit rows");
    assert.match(
      note,
      /cost and activity can be read against them/i,
      "and say why the cut was made, or a reader takes it for missing data",
    );
    assert.equal(coverage.notUploaded?.alsoHeldOut?.marketingCommitted, 9_000, "carried as data, not only prose");

    // The heading must name the span the figures answer, never the span that was asked for.
    assert.equal(figureWindowLabel(coverage), "Jul 2026", "the header prints the figure window");
    assert.notEqual(
      figureWindowLabel(coverage),
      window.label,
      "and it differs from the requested range — naming that range is the mislabel this closes",
    );

    // When nothing is held out the two are the same and nothing extra is claimed.
    const whole = buildCoverage({
      window,
      rows: [salesRow({ period: "2026-07", targetValue: 10, actualValue: 10, hasTarget: true })],
      uploaded: new Set(window.periods),
      marketing: NO_MARKETING,
      outstation: NO_OUTSTATION,
      visits: NO_VISITS,
      unplaced: overlays.unplaced,
      adjustment: null,
    });
    assert.equal(whole.figureWindow, null, "no figure window when every month counts");
    assert.equal(figureWindowLabel(whole), window.label, "and the header falls back to the window itself");
  }

  // ─────────── A LINE VIEW SHOWS THAT LINE'S PEOPLE (owner ruling 2026-09-26) ───────────
  //
  // The role and people tables were fed `company.roles` / `company.people` in BOTH views, with no
  // caption, so "Pedia Line — Deep Analysis" ended with every rep, manager and Head-Office person
  // in the business and a reader took those rows for Pedia's. Neither row type carried a line, and
  // the builder could not place anybody because it RACED the attribution map.
  //
  // These are source pins because the builders are module-private and need a database; what they
  // guard is that the wiring cannot quietly revert to the company-wide set.
  {
    const canonical = flat(SRC("src/lib/business-review/canonical.ts"));
    assert.ok(
      canonical.includes("const attribution = await buildAttributionMap(rows, interested);"),
      "the attribution map must be built BEFORE the role tables, not concurrently with them",
    );
    assert.ok(
      canonical.includes("const roles = buildRoleFacts({"),
      "and the role tables must be built from it, synchronously",
    );
    assert.ok(
      canonical.includes("roles.byLine[LINE_CODE[id]] ?? EMPTY_ROLE_FACTS"),
      "every dataset must get ITS OWN line's role facts",
    );
    assert.ok(
      !canonical.includes("loadRoleFacts({ window, visits, outstation, marketing })"),
      "the racing loader is gone — it could not place anyone on a line",
    );

    const dashboard = flat(SRC("src/components/business-review/dashboard.client.tsx"));
    assert.ok(
      dashboard.includes("<RoleActivityTable roles={roles} scopeNote={`${ds.meta.line} line only`} />"),
      "the line view renders its own roles and says so",
    );
    assert.ok(
      dashboard.includes('<RoleActivityTable roles={company.roles} scopeNote="all three lines" />'),
      "and the company view says what IT is showing, or two identical headings hide the difference",
    );
    assert.ok(
      !dashboard.includes("roles={company.roles} people={company.people} />"),
      "the line view must never be handed the company-wide set again",
    );
  }

  // ─────────── COACHING IS OUT OF THIS MODULE (owner ruling 2026-09-26) ───────────
  //
  // "Leave him out and remove the coaching from this module." The source-level sweep lives in
  // business-review-month-end.test.ts, over every file in sources/; these two pin the surfaces.
  {
    const rollups = flat(SRC("src/components/business-review/rollups.client.tsx"));
    assert.ok(!rollups.includes("coachingReports"), "the role table no longer prints coaching reports");
    const coverageClient = flat(SRC("src/components/business-review/coverage.client.tsx"));
    assert.ok(
      !coverageClient.includes("Coaching reports"),
      "and the coverage sheet no longer names coaching as a source of this module",
    );
    // `repsCoached` is NOT coaching — it is the distinct reps a manager rode along with, from the
    // visit feed. It stays, and the distinction is the whole reason the removal is safe.
    const roles = flat(SRC("src/lib/business-review/sources/roles.ts"));
    assert.ok(roles.includes("repsCoached: acc.reps.size"), "rides ridden with survive the coaching removal");
  }
  // ─────────── A HELD-OUT MONTH GETS NO COLUMN (owner ruling 2026-09-28) ───────────
  //
  // 🔴 A MONTHLY TABLE ITERATES THE FIGURE WINDOW, NEVER THE REQUESTED ONE. `meta.months` is the
  // window that was ASKED for and `meta.period` is the window the figures ANSWER; a section that
  // walks the first under a heading naming the second prints a column for a month deliberately
  // held out, filled by `?? 0`. Measured on the 87 rep packs of 2026-09-28: every one carried a
  // SEP column of zeros — including a rep with 147 customers in July and 151 in August — while
  // the cover of that same sheet said September's 13,450 CRM rows were held out and were real.
  // A reader sees "0 customers in September" for someone who worked all September. The owner's
  // ruling: drop the month entirely, the cover already explains why it is out.
  {
    // AVAILABLE stops at August, and the resolver CLAMPS to it — so a window asked for with
    // windowOf() here would silently be two months and this whole block would pass vacuously.
    // September has to be in the available list for the held-out case to exist at all.
    const requested = resolveReviewWindow("2026-07", "2026-09", [...AVAILABLE, "2026-09"]).window;
    const rows = requested.periods.map((period) => salesRow({ period, hasTarget: true, targetValue: 900_000 }));
    const coverage = buildCoverage({
      window: requested, rows, uploaded: UPLOADED(requested),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
      figureWindow: { label: "Jul - Aug 2026", periods: ["2026-07", "2026-08"] },
    });
    assert.equal(requested.periods.length, 3, "the fixture window must really hold three months");
    const months = figureWindowPeriods(coverage);
    assert.deepEqual(
      [...months],
      ["2026-07", "2026-08"],
      "the months a pack renders are the FIGURE window's — a held-out month gets no column at all",
    );
    assert.ok(
      !months.includes("2026-09"),
      "September was held out of every figure, so it must not appear as a column of zeros",
    );

    // and with nothing held out, nothing is dropped
    const plain = buildCoverage({
      window: requested, rows, uploaded: UPLOADED(requested),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });
    assert.deepEqual(
      [...figureWindowPeriods(plain)],
      requested.periods,
      "when the figure window IS the requested window, every month keeps its column",
    );

    // the caller that matters is pinned by source, because no unit test can render the route
    const route = flat(SRC("app/api/business-review/pack/route.ts"));
    assert.ok(
      route.includes("months: figureWindowPeriods(coverage)"),
      "the pack route must hand the model the FIGURE window's months, never meta.months",
    );
  }

  // ─────────── A COMPLETE WINDOW READS ITS CUSTOMERS (2026-10-29) ───────────
  //
  // 🔴 `figureWindow` is NULL when nothing was held out — the ordinary case — and the customer-grain
  // loader read `figureWindow?.periods ?? []`, so every complete window read NO months: the brick,
  // customer and channel pages of every pack and portal page came back empty. A rep's Jul–Sep pack
  // printed 0 · 0 · 0 on every channel beside EGP 222,448 of sales on its first page.
  {
    const requested = resolveReviewWindow("2026-07", "2026-09", [...AVAILABLE, "2026-09"]).window;
    const rows = requested.periods.map((period) => salesRow({ period, hasTarget: true, targetValue: 900_000 }));
    const complete = buildCoverage({
      window: requested, rows, uploaded: UPLOADED(requested),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });
    assert.equal(complete.figureWindow, null, "a complete window carries NO figure window — the shape that read nothing");
    assert.deepEqual(
      concentrationPeriods(complete),
      ["2026-07", "2026-08", "2026-09"],
      "a complete window reads its customers for EVERY month — never none",
    );

    const heldOut = buildCoverage({
      window: requested, rows, uploaded: new Set(["2026-07", "2026-08"]),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
      figureWindow: { label: "Jul - Aug 2026", periods: ["2026-07", "2026-08"] },
    });
    assert.deepEqual(
      concentrationPeriods(heldOut),
      ["2026-07", "2026-08"],
      "a month whose files have not landed stays out of the bricks, customers and channels",
    );

    const nothingLanded = buildCoverage({
      window: requested, rows, uploaded: new Set<string>(),
      marketing: NO_MARKETING, outstation: NO_OUTSTATION, visits: NO_VISITS,
      unplaced: NO_UNPLACED, adjustment: null,
    });
    assert.equal(nothingLanded.figureWindow, null);
    assert.deepEqual(
      concentrationPeriods(nothingLanded),
      [],
      "a window where no month's files have landed still reads none — every month is held out",
    );

    const service = stripComments(SRC("src/lib/business-review/service.ts"));
    assert.ok(
      flat(service).includes("const periods = concentrationPeriods(input.coverage);"),
      "the customer-grain loader takes its months from concentrationPeriods",
    );
    assert.ok(
      !service.includes("figureWindow?.periods ?? []"),
      "and never from the figure window alone, which is null for a complete window",
    );
  }
}

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { reconcileUnattributed } from "../src/lib/employee-portal/performance-reconciliation.ts";

/**
 * Regression coverage for the performance-page reconciliation line.
 *
 * The NSM / CEO performance surfaces show a HEADLINE total covering every scoped
 * Source-of-Sales row, above a leaderboard that only lists seated reps / DMs. The gap —
 * Direct Orders spread across regions + vacant seats — must be surfaced as an explicit
 * "unattributed" figure so the header foots to the rows the viewer can see (up to ~39%
 * of a line's July 2026 actual). This locks both the pure math and the render wiring.
 */
export function runPerformanceReconciliationTests() {
  // -- 1. The core identity: headline = Σ(members) + unattributed.
  //    Real July 2026 Anti-Infective line (verified live): line headline 606,139;
  //    the seated reps sum to 368,950; the 237,189 gap is Direct Orders + vacant seats.
  const aiReps = [
    { totalSales: 200000, totalTarget: 250000 },
    { totalSales: 168950, totalTarget: 180000 },
  ];
  const ai = reconcileUnattributed({ sales: 606139, target: 430000 }, aiReps);
  assert.equal(ai.unattributedSales, 606139 - 368950, "AI unattributed sales = headline − Σ reps (237,189)");
  assert.equal(
    aiReps.reduce((sum, r) => sum + r.totalSales, 0) + ai.unattributedSales,
    606139,
    "header must foot exactly: Σ(reps) + unattributed = headline",
  );

  // -- 2. A fully-attributed scope needs no reconciliation line (exactly 0, not noise).
  const full = reconcileUnattributed(
    { sales: 500, target: 500 },
    [{ totalSales: 300, totalTarget: 300 }, { totalSales: 200, totalTarget: 200 }],
  );
  assert.equal(full.unattributedSales, 0, "fully-attributed headline leaves 0 unattributed");
  assert.equal(full.unattributedTarget, 0, "fully-attributed target leaves 0 unattributed");

  // -- 3. Sub-piastre float noise is clamped to 0 (so the note hides instead of showing 0.0001).
  const noisy = reconcileUnattributed(
    { sales: 100.0000001, target: 0 },
    [{ totalSales: 100, totalTarget: 0 }],
  );
  assert.equal(noisy.unattributedSales, 0, "float noise below half a piastre clamps to 0");

  // -- 4. Empty leaderboard: the entire headline is unattributed (all sales sat on no seat).
  const orphaned = reconcileUnattributed({ sales: 12345, target: 0 }, []);
  assert.equal(orphaned.unattributedSales, 12345, "no members → the whole headline is unattributed");

  // -- 5. Returns/credit notes can push a seat negative; the identity must still hold.
  const withReturns = reconcileUnattributed(
    { sales: 1000, target: 1000 },
    [{ totalSales: 1200, totalTarget: 1000 }, { totalSales: -50, totalTarget: 0 }],
  );
  assert.equal(
    withReturns.unattributedSales,
    1000 - (1200 - 50),
    "identity holds even when a member row is negative (−150)",
  );

  // ===========================================================================
  // WIRING: the builders + all five render surfaces must actually use it.
  // sos-team-performance.ts pulls in the env-bound Supabase client, so (like the
  // hierarchy-continuity test) we lock the integration points via source text.
  // ===========================================================================
  const sosSource = readFileSync(
    new URL("../src/lib/employee-portal/sos-team-performance.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    sosSource,
    /reconcileUnattributed\(/,
    "the SoS performance builders must compute the unattributed slice",
  );

  const serviceSource = readFileSync(
    new URL("../src/lib/employee-portal/service.ts", import.meta.url),
    "utf8",
  );
  assert.match(serviceSource, /unattributedSales: number;/, "team/line shapes must expose unattributedSales");
  assert.match(
    serviceSource,
    /companyUnattributedSales: number;/,
    "company shapes must expose companyUnattributedSales",
  );

  const renderSurfaces = [
    "../app/employee-portals/dsms-performance/page.tsx",
    "../app/employee-portals/med-reps-performance/page.tsx",
    "../app/employee-portals/team-performance/page.tsx",
    "../app/(admin)/admin/field-sales/dsm-performance/page.tsx",
    "../app/(admin)/admin/field-sales/med-reps-performance/page.tsx",
  ];
  for (const surface of renderSurfaces) {
    const source = readFileSync(new URL(surface, import.meta.url), "utf8");
    assert.match(
      source,
      /PerformanceReconciliationNote/,
      `${surface} must render the reconciliation note so its header foots to the leaderboard`,
    );
  }
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RESTRICTED_PRODUCT_CODES } from "../src/lib/sales/access-scope.ts";
import {
  buildSourceOfSalesDashboard,
  type SourceOfSalesSummaryRecord,
  type SourceOfSalesUploadBatch,
} from "../src/lib/sales/monthly-distributor-import.ts";

/**
 * THE SOURCE OF SALES DASHBOARD SHOWS THE SAME, LIVE GEOGRAPHY TO EVERY VIEWER.
 *
 * ## The defect, from the 2026-08-09 audit (verified 2026-09-04, run wf_b7ad5542-d94)
 *
 * The audit found a PAIR that only bit together. **Half of it is already fixed, and this file pins
 * the other half** — read both, because the fixed half is what makes the remaining one look
 * harmless:
 *
 *  1. `source_of_sales_import_summaries` was written ONCE at commit with no updater anywhere, so
 *     after a re-map its `area`/`brick`/`region` rows kept the geography the file had at import
 *     time. **FIXED on 2026-09-05**, after the audit ran, by
 *     `20260905003000_territory_sync_refreshes_import_summaries.sql` (which calls the
 *     `phx_refresh_sos_import_summaries` added on 2026-08-30) plus
 *     `20260905003100_backfill_sos_import_summaries.sql`. Confirmed on production: for 2026-07,
 *     **0 areas disagree** with the live rows, against 17 validated batches, 479 area summary rows
 *     and 44,238 live rows — so the check is measuring something, not an empty join.
 *  2. The loader called the live geo RPC only when something had to be EXCLUDED. A Super Admin or
 *     the CEO needs nothing excluded, so the call was skipped, `geoSummaries` stayed `undefined`,
 *     and the unrestricted path in `buildSourceOfSalesDashboard` read geography from the summaries.
 *     **This is what is fixed here.**
 *
 * The audit measured what (1) had already cost: 40 areas disagreeing, 314 rows in the wrong area,
 * **1,172,838.83 EGP misattributed** for 2026-07, worst pair GZ6/UE9 — the Fayoum / Beni Suef
 * split. That figure is HISTORICAL as of the backfill; do not quote it as a live number.
 *
 * ## Why (2) still matters once (1) is fixed
 *
 * Because it left the two views structurally different rather than merely disagreeing. A Regional
 * Manager's geography is COMPUTED from the rows on every request; the CEO's is a CACHE that is
 * correct only while something remembers to refresh it. Today they agree because the refresh was
 * wired in — but the refresh hangs off `phx_sync_sos_run`, so any future path that changes rows
 * without going through it silently re-opens the gap, and re-opens it **only for the two roles that
 * sign off the month**, with no signal to either party that they are looking at different data. The
 * number above is what that divergence costs when it happens.
 *
 * ## Why the fix needed BOTH halves
 *
 * Passing `geoSummaries` from the loader alone changes nothing: the unrestricted path returns early
 * and, before this, never read `geoSummaries` at all. Fixing that path alone also changes nothing:
 * the loader never populated it for those roles. Either half on its own is a silent no-op, which is
 * exactly the shape that ships looking done — so both are pinned below.
 *
 * These tests pin FRESHNESS. They must not be read as relaxing any visibility lock: the exclusion
 * list for a fully privileged viewer is empty because they are entitled to everything, and
 * `sos-import-dashboard-head-office-lock.test.ts` still owns the locks themselves.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function summary(input: Partial<SourceOfSalesSummaryRecord> & { groupType: string }): SourceOfSalesSummaryRecord {
  return {
    batchId: "batch-1",
    groupCode: null,
    groupKey: input.groupLabel ?? input.groupType,
    groupLabel: input.groupType,
    officialLine: null,
    rowCount: 1,
    totalBonusQty: 0,
    totalQty: 1,
    totalValue: 0,
    ...input,
  };
}

function area(code: string, label: string, value: number, rowCount: number): SourceOfSalesSummaryRecord {
  return summary({
    groupCode: code,
    groupKey: `${code}|${label}`,
    groupLabel: label,
    groupType: "area",
    rowCount,
    totalValue: value,
  });
}

function product(code: string, label: string, line: string, value: number): SourceOfSalesSummaryRecord {
  return summary({
    groupCode: code,
    groupKey: `${code}|${label}|${line}`,
    groupLabel: label,
    groupType: "product",
    officialLine: line,
    totalValue: value,
  });
}

// No `as` cast — the fixture is checked against the real type, so a field drifting here is a
// compile error rather than a silently-wrong test.
const batch: SourceOfSalesUploadBatch = {
  batchId: "batch-1",
  blockingReasons: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  distributorCode: "D1",
  distributorName: "Distributor One",
  failedRows: 0,
  fileName: "d1.xlsx",
  importableRows: 1590,
  period: "2026-07",
  rowCount: 1590,
  status: "validated",
  templateKey: "generic",
  totalBonusQty: 0,
  totalQty: 1590,
  totalValue: 1000,
  uploadedBy: "hr-1",
  warningRows: 0,
};

/**
 * The GZ6/UE9 drift, at the shape production had it: the summaries were baked before the re-map and
 * still credit GZ6; the rows have since been re-stamped to UE9 and the RPC reads them live.
 */
const STALE_SUMMARIES = [
  area("GZ6", "Fayoum", 731_333.28, 847),
  area("UE9", "Beni Suef", 0, 642),
  product("P1", "Product One", "CNS", 731_333.28),
];
const LIVE_GEO = [area("GZ6", "Fayoum", 0, 768), area("UE9", "Beni Suef", 731_333.28, 722)];

function areaRows(dashboard: { byArea: { code: string | null; rowCount: number }[] }) {
  return Object.fromEntries(dashboard.byArea.map((row) => [row.code ?? "", row.rowCount]));
}

export function runSosDashboardGeographyIsLiveForEveryViewerTests() {
  const base = { availablePeriods: ["2026-07"], batches: [batch], period: "2026-07" };

  // ── 1. THE HEADLINE — the unrestricted viewer gets the LIVE geography ────────────────────────
  // Break either half of the fix and this fires: it is the only assertion that distinguishes
  // "re-map applied" from "re-map silently ignored on this one page".
  const ceo = buildSourceOfSalesDashboard({ ...base, geoSummaries: LIVE_GEO, summaries: STALE_SUMMARIES });
  assert.deepEqual(
    areaRows(ceo),
    { GZ6: 768, UE9: 722 },
    "the CEO / Super Admin path is reading source_of_sales_import_summaries for geography again. That "
      + "is a CACHE, correct only while phx_sync_sos_run refreshes it; the scoped path computes the "
      + "same geography from the rows on every request. When the two diverge it is these two roles "
      + "that get the wrong copy — the audit measured 314 rows and 1,172,838.83 EGP in the wrong area "
      + "for 2026-07 before the refresh was wired in",
  );

  // ── 2. THE INVERSION — a scoped viewer already got this right, and both must now agree ───────
  // The point of the finding is not that one number was wrong; it is that two viewers of the SAME
  // page saw different geography with no signal, and the privileged one was the wrong one.
  const regionalManager = buildSourceOfSalesDashboard({
    ...base,
    geoSummaries: LIVE_GEO,
    restrictedProductCodes: RESTRICTED_PRODUCT_CODES as unknown as string[],
    summaries: STALE_SUMMARIES,
  });
  assert.deepEqual(
    areaRows(regionalManager),
    areaRows(ceo),
    "the CEO and a Regional Manager must see the same areas for the same period. Before the fix the "
      + "RM saw GZ6 768 / UE9 722 (live) while the CEO saw 847 / 642 (stale) — an inverted privilege "
      + "gradient, where the two roles that sign off the month got the wrong copy",
  );

  // ── 3. NOT over-applied — the non-geography dimensions still come from the summaries ─────────
  // Only area/brick/region are re-mapped by phx_sync_sos_run. byLine and byProduct are computed
  // from the product-grain summary rows, and swapping them to the geo aggregate would drop the
  // product dimension entirely (the RPC returns no product rows).
  assert.deepEqual(
    ceo.byProduct.map((row) => row.code),
    ["P1"],
    "byProduct must still be built from the product-grain summaries — the geo RPC returns no product "
      + "rows, so sourcing it from geoSummaries would silently empty the Products table",
  );

  // ── 4. THE FALLBACK SURVIVES — no geoSummaries means the summaries, not a blank page ─────────
  // The loader passes `undefined` when the RPC errors for a viewer with nothing to exclude. That
  // must degrade to stale-but-present geography, never to an empty split: a freshness fix must not
  // introduce a new outage on a transient RPC failure.
  const rpcSkipped = buildSourceOfSalesDashboard({ ...base, summaries: STALE_SUMMARIES });
  assert.deepEqual(
    areaRows(rpcSkipped),
    { GZ6: 847, UE9: 642 },
    "with no geoSummaries the unrestricted path must fall back to the summaries (stale, but present) "
      + "rather than rendering an empty region/area/brick section",
  );

  // ── 5. THE LOADER HALF — the RPC is no longer gated on privilege ─────────────────────────────
  // Asserted on the source because the loader needs a live Supabase client. Narrow regexes, not a
  // byte window: the point is the CONDITION, and it must survive reformatting.
  const loader = readSource("../src/lib/sales/monthly-distributor-import.ts");
  assert.ok(
    !/if \(\(!canViewRestricted \|\| !canViewHeadOffice\) && batchIds\.length > 0\)/.test(loader),
    "the geo RPC is gated on privilege again, so a viewer who needs nothing excluded is skipped and "
      + "falls back to the stale summaries — the exact defect this file pins",
  );
  assert.ok(
    /const scopedViewer = !canViewRestricted \|\| !canViewHeadOffice;/.test(loader)
      && /const geoFailureFallback = scopedViewer \? \[\] : undefined;/.test(loader),
    "the two failure semantics must stay explicit: a scoped viewer fails CLOSED to [] so a broken RPC "
      + "cannot leak confidential value through the unfiltered summaries, while a fully privileged "
      + "viewer degrades to undefined (the summaries) rather than losing the section",
  );
  assert.ok(
    /geoSummaries = geoFailureFallback;/.test(loader),
    "the RPC error branch must use the per-viewer fallback rather than blanking geography for everyone",
  );
  assert.ok(
    /const unrestrictedGeoSource = input\.geoSummaries \?\? input\.summaries;/.test(loader),
    "the unrestricted early-return path must consult geoSummaries. It returns before the scoped path, "
      + "so without this the loader half is a silent no-op and the CEO keeps the stale geography",
  );
}

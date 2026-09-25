import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getMergedAreaName } from "../src/lib/sales/closing-area-merges.ts";
import { stripComments } from "./support/comment-strip.ts";

// THE DEFECT: the admin sales Targets authoring page (app/(admin)/sales/targets/page.tsx) built
// its row `areaName` with `getMergedAreaName(selectedLine, area.areaCode)` — no period argument —
// even though `selectedPeriod` was already resolved a few lines above (and used two lines below at
// `loadMonthlyTargets(selectedPeriod)`). getMergedAreaName defaults to TODAY's month when no period
// is passed, so authoring a target for any month other than the current one mislabelled a dated
// area merge — e.g. Anti Infective's OT2/OT9 -> "Ismailia and Suez", a merge CLOSING_AREA_MERGES
// only dates from 2026-09-01. This is the identical bug fixed in src/lib/sales/vs-target-page.ts and
// app/employee-portals/targets/page.tsx's manager branch — see
// tests/vs-target-page-area-merge-period.test.ts (PR #4403).
//
// Fixed by threading the page's own resolved `selectedPeriod` through to `getMergedAreaName`.
export async function runTargetsPageAreaMergePeriodTests() {
  // ── THE HEADLINE ────────────────────────────────────────────────────────────
  // August 2026 predates the Anti Infective Ismailia/Suez fold (2026-09-01 per
  // CLOSING_AREA_MERGES). A target authored for August must not resolve to the merged name.
  assert.notEqual(
    getMergedAreaName("anti_infective", "OT2", "2026-08"),
    "Ismailia and Suez",
    "an August OT2 lookup must not resolve to 'Ismailia and Suez' — that merge only starts 2026-09",
  );

  // September proves the period argument is actually READ, not merely accepted and ignored — the
  // same code, one month later, must flip to the merged name.
  assert.equal(
    getMergedAreaName("anti_infective", "OT2", "2026-09"),
    "Ismailia and Suez",
    "from September the same OT2 code IS the merged area",
  );

  // ── Wiring: the page's call site must pass selectedPeriod ─────────────────
  // A behavioural test of getMergedAreaName alone cannot see a regression where the page reverts to
  // calling it with no period argument. Pin the actual call site.
  const pageSource = stripComments(
    readFileSync(new URL("../app/(admin)/sales/targets/page.tsx", import.meta.url), "utf8"),
  );
  assert.ok(
    pageSource.includes('getMergedAreaName(selectedLine, area.areaCode, selectedPeriod)'),
    "the admin Targets authoring page must pass selectedPeriod to getMergedAreaName — omitting it " +
      "defaults the merge lookup to today's month regardless of which month the grid is authoring " +
      "targets for",
  );
}

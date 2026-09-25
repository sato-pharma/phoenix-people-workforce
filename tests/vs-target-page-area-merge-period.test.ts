import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildVsTargetNames } from "../src/lib/sales/vs-target-page.ts";
import { stripComments } from "./support/comment-strip.ts";

// THE DEFECT: `buildVsTargetDashboard` used to build its `names.areaName` resolver BEFORE
// resolving `period`, then called `getMergedAreaName(activeLine, code)` with no third argument —
// which defaults to TODAY's month (closing-area-merges.ts's `currentClosingPeriod()`), not the
// month the dashboard actually landed on. On any day from 2026-09-01 onward, that mislabelled
// every earlier Anti Infective OT2 row (e.g. August 2026) as "Ismailia and Suez", a merge which
// CLOSING_AREA_MERGES dates from 2026-09-01 — and it lost the Pedia Fayoum/Beni Suef merge for
// any month where THAT rule is in force but today's month is not. The manager branch of the
// portal Targets page (app/employee-portals/targets/page.tsx) carried the identical bug.
//
// Fixed by resolving `period` first and threading it through a single pure `buildVsTargetNames`
// export, so the naming rule always answers for the month actually on screen — never "now".
export async function runVsTargetPageAreaMergePeriodTests() {
  const areaNames = new Map([
    ["OT2", "Suez"],
    ["OT9", "Ismailia"],
  ]);
  const employeeNames = new Map<string, string>();

  // ── THE HEADLINE ────────────────────────────────────────────────────────────
  // August 2026 predates the Anti Infective Ismailia/Suez fold (2026-09-01 per
  // CLOSING_AREA_MERGES). A dashboard landing on August must still show OT2 under its own name.
  const august = buildVsTargetNames("anti_infective", "2026-08", areaNames, employeeNames);
  assert.notEqual(
    august.areaName("OT2"),
    "Ismailia and Suez",
    "an August OT2 row must not be named 'Ismailia and Suez' — that merge only starts 2026-09",
  );
  assert.equal(august.areaName("OT2"), "Suez", "August keeps OT2 under its own, unmerged name");

  // September proves the period argument is actually READ, not merely accepted and ignored — the
  // same code, one month later, must flip to the merged name.
  const september = buildVsTargetNames("anti_infective", "2026-09", areaNames, employeeNames);
  assert.equal(
    september.areaName("OT2"),
    "Ismailia and Suez",
    "from September the same OT2 code IS the merged area",
  );

  // A line with no dated merge rule (CNS's own Fayoum/Beni Suef fold aside) is unaffected either
  // way — the period argument must never invent a merge that CLOSING_AREA_MERGES does not define.
  const cnsAugust = buildVsTargetNames("cns", "2026-08", areaNames, employeeNames);
  assert.equal(cnsAugust.areaName("OT2"), "Suez", "a line with no OT2/OT9 rule never merges it, at any period");

  // A code with no canonical name and no merge falls back to "Unassigned area", never the raw
  // code — the owner's standing "never show a code" rule.
  const unassigned = buildVsTargetNames("anti_infective", "2026-08", new Map(), employeeNames);
  assert.equal(unassigned.areaName("ZZ9"), "Unassigned area", "an unknown code never renders as itself");

  // ── The product roll-up's raw-code fallback ────────────────────────────────
  // vs-target-page.ts used to fall back to the raw product code when a name was missing;
  // rep-targets.ts already used "Unnamed product" for the identical gap. The two Targets-family
  // screens must agree.
  const vsTargetPageSource = stripComments(
    readFileSync(new URL("../src/lib/sales/vs-target-page.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    vsTargetPageSource.includes('productNames.get(code.toUpperCase()) ?? "Unnamed product"'),
    "the product roll-up must fall back to 'Unnamed product', never a raw product code, matching rep-targets.ts",
  );
  assert.ok(
    !vsTargetPageSource.includes("productNames.get(code.toUpperCase()) ?? code)"),
    "the old raw-code fallback must be gone",
  );

  // ── Wiring: `names` must be built AFTER `period` is resolved ───────────────
  // A behavioural test of buildVsTargetNames alone cannot see a regression where the dashboard
  // builder stops calling it with the real `period` (e.g. reverts to calling getMergedAreaName
  // directly, with no third argument). Pin the actual call site.
  assert.ok(
    /const names = buildVsTargetNames\(activeLine, period, areaNames, employeeNames\);/.test(vsTargetPageSource),
    "buildVsTargetDashboard must build `names` from the resolved `period`, not before it is known",
  );
  const namesCallIndex = vsTargetPageSource.indexOf("const names = buildVsTargetNames(");
  const periodDeclIndex = vsTargetPageSource.indexOf(
    "const period = explicitPeriod ?? pickLandingPeriod(scopedAllRaw, publishedKeys, current);",
  );
  assert.ok(periodDeclIndex !== -1, "the period-resolution line must still exist for this pin to mean anything");
  assert.ok(
    namesCallIndex > periodDeclIndex,
    "`names` must be constructed AFTER `period` is resolved — building it earlier is exactly the regression " +
      "this test exists to catch, since it silently makes every merged-area lookup default to today's month",
  );

  // ── The manager branch of the portal Targets page carries the same bug ────
  const portalTargetsSource = stripComments(
    readFileSync(new URL("../app/employee-portals/targets/page.tsx", import.meta.url), "utf8"),
  );
  assert.ok(
    portalTargetsSource.includes('getMergedAreaName(selectedLine, row.areaCode ?? "", selectedPeriod)'),
    "the portal Targets manager branch must pass selectedPeriod to getMergedAreaName — omitting it defaults " +
      "the merge lookup to today's month regardless of which month the grid is actually showing",
  );
}

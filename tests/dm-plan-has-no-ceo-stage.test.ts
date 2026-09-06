import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlanCeoDecision } from "../src/lib/weekly-planning/plan-v1.ts";

/**
 * A District Manager plan is submit -> NSM (or RSM if applicable) -> HR acknowledge, with NO CEO
 * stage — owner rule, 2026-09-05 (AGENTS.md §4). Every DM `ceo_approve` row was deleted from
 * `employee_plan_decisions` on his instruction, but the denormalised `ceo_decision_*` copy on
 * `employee_plan_headers` was left behind on 8 plans — so the decision-history screens kept
 * attributing those approvals to the CEO / Super Admin while the audit trail said they had never
 * happened. Those stamps were cleared in production on 2026-09-06; this pins the property that
 * made the mismatch visible, so no read path can show a CEO decision on a plan kind that has no
 * CEO stage, whatever the header happens to hold.
 */

// The exact header shape that caused the incident: stamped, with no decision row behind it.
const STAMPED_AT = "2026-08-08T12:14:28.143297+00:00";
const STAMPED_BY = "B-10";

const DM_TITLES = ["District Sales Manager", "District Manager", "DSM"];

const CEO_STAGE_TITLES = [
  "National Sales Manager",
  "Regional Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
];

// Both decision-history read paths must ask the helper rather than read the column.
const WIRED_CALLERS = ["src/lib/approvals-hub/service.ts", "src/lib/action-center/service.ts"];

export function runDmPlanHasNoCeoStageTests() {
  // 1. The headline: a DM plan yields no CEO decision even when the header is fully stamped.
  for (const title of DM_TITLES) {
    assert.equal(
      resolvePlanCeoDecision(title, STAMPED_AT, STAMPED_BY),
      null,
      `a ${title} plan has no CEO stage, so a stamped header is residue and is never the CEO's decision`,
    );
  }

  // 2. The CEO stage still works everywhere it genuinely exists — 56 non-DM ceo_approve rows in
  //    production depend on this, so the guard must not become a blanket suppression.
  for (const title of CEO_STAGE_TITLES) {
    assert.deepEqual(
      resolvePlanCeoDecision(title, STAMPED_AT, STAMPED_BY),
      { decidedAt: STAMPED_AT, byHrId: STAMPED_BY },
      `a ${title} plan does have a CEO stage — its decision must survive intact`,
    );
  }

  // 3. No stamp is no decision; a missing decider is not a reason to drop a real one.
  assert.equal(
    resolvePlanCeoDecision("National Sales Manager", null, null),
    null,
    "an unstamped header has no CEO decision to show",
  );
  assert.equal(
    resolvePlanCeoDecision("National Sales Manager", "", STAMPED_BY),
    null,
    "an empty timestamp is not a decision, however the decider column reads",
  );
  assert.deepEqual(
    resolvePlanCeoDecision("National Sales Manager", STAMPED_AT, null),
    { decidedAt: STAMPED_AT, byHrId: "" },
    "a stamped decision with no recorded decider still happened — it renders unattributed, never reassigned to the manager",
  );

  // 4. An unknown or absent job title keeps the CEO stage. Failing closed here would silently
  //    hide real CEO decisions company-wide, which is a worse bug than the one being fixed.
  assert.deepEqual(
    resolvePlanCeoDecision(null, STAMPED_AT, STAMPED_BY),
    { decidedAt: STAMPED_AT, byHrId: STAMPED_BY },
    "only a District Manager title drops the CEO stage; an unknown title must not",
  );

  // 5. The wiring. A correct helper that nobody calls is exactly how this reached production:
  //    both decision-history paths must resolve through it, never off the header stamp alone.
  for (const file of WIRED_CALLERS) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(
      source.includes("resolvePlanCeoDecision("),
      `${file} must resolve a plan's CEO attribution through resolvePlanCeoDecision`,
    );
    assert.ok(
      !source.includes("Boolean(row.ceo_decision_at)"),
      `${file} must not decide whose decision a plan was from the header stamp alone`,
    );
  }
}

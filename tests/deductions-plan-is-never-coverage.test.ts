// 🔴 A WEEKLY PLAN IS NEVER COVERAGE IN THE DEDUCTIONS MODULE — AND ONE CONNECTOR MAY READ ONE.
//
// Owner, 2026-10-12, asked whether a submitted weekly plan should count as coverage for a
// no-activity day: *"NO NEVER COUNT WEEKLY PLAN AS COVERAGE WHAT IF HE PLANNED BUT DIDNT GO WORK?"*
// Asked how far that reaches: *"Do not ever touch a weekly plan. All what you do that you see the
// weekly plan and the daily reports and compare the plan versus the actual, any title."* And the one
// carve-out, in his own words: *"The only thing that touches the weekly monthly plan is a head office
// employee that not submitted a weekly plan until Monday the same week."*
//
// So, inside this module:
//   · `no_weekly_plan` is the ONE connector that may read a plan at all, and it CHARGES the missing
//     plan (head office, filed by the Monday of that week). It never excuses a day with one.
//   · nothing else reads a plan header, a plan item, or any flag derived from one.
//
// WHY A SOURCE TEST AND NOT A BEHAVIOUR TEST. The behaviour is pinned where each rule lives
// (tests/deductions-half-day.test.ts for the half day, tests/private-calendar-plan-source.test.ts for
// the No Activity engine). What those cannot catch is the NEXT wiring: between 2026-10-08 and his
// ruling, a plan reached the half-day rule through a loader in another module
// (`loadApprovedCoveringPlanItems`), and reached the no-activity engine through a display flag on a
// calendar item. Both were one import away from a module that charges money, and neither import
// looked like coverage at the call site. This test reads the files.
//
// Account: docs/private-calendar-plan-is-never-coverage.md

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

/** Every .ts file under the two deductions domains, recursively. */
function domainFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url))) {
      const next = `${relative}/${entry}`;
      if (statSync(new URL(`../${next}`, import.meta.url)).isDirectory()) {
        walk(next);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      out.push({ path: next, text: readFileSync(new URL(`../${next}`, import.meta.url), "utf8") });
    }
  };
  walk("src/lib/deductions");
  walk("src/lib/daily-deductions");
  return out;
}

/** The plan's own tables and the loaders that read them. A comment mentioning a plan is not a read. */
const PLAN_READ = /employee_plan_headers|employee_plan_items|phoenix_crm_plans|loadApprovedCoveringPlanItems|loadPlanPrivateCalendarItems|plannedActivityIsRecordedNowhereElse|plannedActivityCoversTheDay/;

/**
 * The one connector his carve-out names — the missing-plan charge. Only its I/O half appears here:
 * `no-weekly-plan-select.ts` is pure and names no table, which is the shape this module prefers and
 * section 2 below asserts separately.
 */
const ALLOWED = new Set(["src/lib/daily-deductions/no-weekly-plan.ts"]);

export function runDeductionsPlanIsNeverCoverageTests() {
  const files = domainFiles();
  // A read that found nothing would pass every assertion below and prove nothing.
  assert.ok(files.length >= 40, `the deductions domains should hold dozens of files, read ${files.length}`);

  // ── 1 · Only the missing-plan connector touches a plan ──────────────────────────────────────────
  (function onlyTheMissingPlanConnectorReadsAPlan() {
    const readers = files
      // Strip line comments and block comments before looking: the rule's own account quotes his
      // words about plans in several of these files, and prose is not a read.
      .filter((file) => PLAN_READ.test(file.text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")))
      .map((file) => file.path)
      .sort();
    assert.deepEqual(
      readers,
      [...ALLOWED].sort(),
      "the only file in Deductions that may read a weekly or monthly plan is the no_weekly_plan connector, "
        + "which charges the MISSING plan (owner, 2026-10-12). A new reader here is the defect this "
        + "test exists to catch — route the question to what was RECORDED instead.",
    );
  })();

  // ── 2 · And it charges the missing plan rather than excusing a day ──────────────────────────────
  (function theMissingPlanConnectorCharges() {
    const select = files.find((file) => file.path === "src/lib/daily-deductions/no-weekly-plan-select.ts");
    assert.ok(select, "the no_weekly_plan selection half must exist");
    assert.match(select.text, /category: "no_weekly_plan"/, "it raises its own category");
    assert.match(
      select.text,
      /No weekly plan submitted for/,
      "and its reason names the missing plan — the charge, never a coverage test",
    );
  })();

  // ── 3 · The half-day cover shape carries no plan field ─────────────────────────────────────────
  (function theCoverShapeHasNoPlanField() {
    const rule = readFileSync(new URL("../src/lib/deductions/half-day-rule.ts", import.meta.url), "utf8");
    // Comments stripped: the shape carries a comment naming the two fields it must never carry again.
    const cover = rule
      .slice(rule.indexOf("export type HalfDayCover"), rule.indexOf("export type HalfDayVerdict"))
      .replace(/\/\/.*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(cover.length > 100, "the cover shape should be readable");
    assert.ok(
      !/planAm|planPm/.test(cover),
      "HalfDayCover may not carry a plan half again — `planAm`/`planPm` cleared a half day until 2026-10-12",
    );
  })();
}

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { DEDUCTION_COLLECTORS } from "../src/lib/deductions/collect.ts";
import { compactDeductionsHrId } from "../src/lib/deductions/candidate-key.ts";
import { clipDraftToRange } from "../src/lib/daily-deductions/compute.ts";
import { mondaysInMonth } from "../src/lib/daily-deductions/no-weekly-plan.ts";
import {
  owesAWeeklyPlan,
  selectNoWeeklyPlanDrafts,
  WEEKLY_PLAN_POLICY_FIRST_MONDAY,
  type WeeklyPlanRosterEntry,
} from "../src/lib/daily-deductions/no-weekly-plan-select.ts";
import {
  dailyDeductionCategories,
  dailyDeductionConnectorLabels,
  dailyDeductionConnectors,
} from "../src/lib/daily-deductions/types.ts";
import {
  buildWeekKey,
  planDeductionGraceDeadlineForMonday,
  submissionDeadlineForWeek,
} from "../src/lib/weekly-planning/week.ts";

/**
 * The Daily Deductions "No weekly plan" connector (owner, 2026-10-12): a head-office employee who
 * owes a weekly plan and did not submit one by that week's Monday loses one day.
 *
 * This suite pins the four things that decide whether it is fair, plus the one thing that decides
 * whether it is SAFE: that it can never charge automatically.
 */

const MONTH = 10;
const YEAR = 2026;
// October 2026 has 31 days; a 31,000 base is exactly 1,000.00 a day.
const BASE = 31000;

function person(hrId: string, jobTitle: string | null, extra: Partial<WeeklyPlanRosterEntry> = {}): WeeklyPlanRosterEntry {
  return { hrId, name: `Person ${hrId}`, jobTitle, hireDate: null, endDate: null, ...extra };
}

function salaries(entries: Array<[string, number | null]>): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const [hrId, salary] of entries) {
    const key = compactDeductionsHrId(hrId);
    if (key) map.set(key, salary);
  }
  return map;
}

function leave(entries: Array<[string, string[]]>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [hrId, dates] of entries) {
    const key = compactDeductionsHrId(hrId);
    if (key) map.set(key, new Set(dates));
  }
  return map;
}

// Two Mondays in scope, both on or after the policy floor.
const WEEKS = [
  { weekKey: "2026-W41", mondayIso: "2026-10-12" },
  { weekKey: "2026-W42", mondayIso: "2026-10-19" },
];

function select(input: {
  roster: WeeklyPlanRosterEntry[];
  onTimePlans?: Array<{ weekKey: string; hrId: string }>;
  weeks?: typeof WEEKS;
  approvedLeave?: Array<[string, string[]]>;
  salaryEntries?: Array<[string, number | null]>;
  policyFirstMonday?: string;
}) {
  return selectNoWeeklyPlanDrafts({
    roster: input.roster,
    weeks: input.weeks ?? WEEKS,
    onTimePlans: (input.onTimePlans ?? []).map((plan) => ({
      weekKey: plan.weekKey,
      employeeCompactKey: compactDeductionsHrId(plan.hrId) as string,
    })),
    approvedLeaveByCompact: leave(input.approvedLeave ?? []),
    baseSalaryByCompact: salaries(input.salaryEntries ?? input.roster.map((p) => [p.hrId, BASE])),
    month: MONTH,
    year: YEAR,
    policyFirstMonday: input.policyFirstMonday,
  });
}

export async function runDailyDeductionsNoWeeklyPlanTests(): Promise<void> {
  // ── 🔴 NEVER AUTOMATIC — the structural half of the owner's rule ───────────
  {
    const monthKeys = DEDUCTION_COLLECTORS.map((collector) => collector.key as string);
    assert.equal(
      monthKeys.includes("no_weekly_plan"),
      false,
      "no_weekly_plan must NEVER be a month-module collector — that path writes the ledger on a scan",
    );
    assert.ok(
      (dailyDeductionConnectors as readonly string[]).includes("no_weekly_plan"),
      "it IS a daily connector, where output is a tally the Super Admin publishes by hand",
    );
    const migration = readFileSync(
      new URL("../supabase/migrations/20261012120000_deductions_no_weekly_plan_category.sql", import.meta.url),
      "utf8",
    );
    assert.match(migration, /requires_approval/, "the category row carries requires_approval");
    assert.match(migration, /'no_weekly_plan',\s*'No Weekly Plan',\s*'weekly_plan_submission',\s*true/, "requires_approval is TRUE");
  }

  // ── THE DEADLINE IS THE END OF THE MONDAY BEING CHARGED, CAIRO (23:59:59) ─
  {
    const format = (date: Date) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).format(date);

    const cairo = format(planDeductionGraceDeadlineForMonday("2026-10-12"));
    assert.match(cairo, /^Monday, 12\/10\/2026, 23:59$/, `the grace deadline must be Monday 12 Oct 23:59 Cairo, got "${cairo}"`);
    // Summer: 23:59 EEST (UTC+3) is 20:59 UTC — a flat offset would drift across the DST change.
    assert.equal(format(planDeductionGraceDeadlineForMonday("2026-06-08")), "Monday, 08/06/2026, 23:59");
    // Owner, 2026-10-19: the END of the day, 23:59:59 — a plan sent at 23:59:30 Cairo is on time.
    assert.equal(planDeductionGraceDeadlineForMonday("2026-06-08").toISOString(), "2026-06-08T20:59:59.999Z");
    {
      // Winter (Egypt's summer time ends on the last Thursday of October): 23:59:30 EET (UTC+2) on
      // Monday 9 Nov 2026 is 21:59:30 UTC, and midnight Cairo is 22:00:00 UTC.
      const deadline = planDeductionGraceDeadlineForMonday("2026-11-09").getTime();
      assert.ok(Date.parse("2026-11-09T21:59:30Z") <= deadline, "a plan sent at 23:59:30 Cairo on the Monday is on time");
      assert.ok(Date.parse("2026-11-09T21:59:59.500Z") <= deadline, "so is one sent half a second before midnight");
      assert.ok(Date.parse("2026-11-09T22:00:00Z") > deadline, "midnight Cairo is the Tuesday, and late");
    }

    // 🔴 IT TAKES THE MONDAY, NOT THE WEEK KEY. Production's own plan rows follow buildWeekKey:
    // 2026-W41 runs 11–15 Oct 2026 (read live 2026-10-12).
    assert.equal(buildWeekKey("2026-10-12"), "2026-W41", "the Monday we charge files under the week key production uses");
    assert.equal(buildWeekKey("2026-10-11"), "2026-W41", "…and so does that week's Sunday, the row's period_start_date");

    // This assertion originally pinned a BUG: sundayFromWeekKey was a whole week out, so
    // submissionDeadlineForWeek("2026-W41") answered 1 October, and routing this money through a
    // week key would have charged the wrong Monday. #5768 made it a true inverse of buildWeekKey,
    // so it now lands on the Thursday that actually precedes W41. The pin is corrected rather than
    // deleted: this file charges a day's pay off these helpers, so it is exactly the place that
    // must notice if that inverse ever slips again.
    assert.equal(
      format(submissionDeadlineForWeek("2026-W41")),
      "Thursday, 08/10/2026, 17:00",
      "the planning module's own deadline must sit in the week BEFORE W41 — a week out here is a week out in the money",
    );
    // The Monday-date signature stays, for the reason that outlived the bug: these two deadlines
    // answer different questions, and the connector already holds the Monday it is charging.
    // Missing pay must be the more forgiving of the two, never the stricter.
    //
    // Asserted over a RANGE of Mondays rather than the one pinned above, and deliberately so: on
    // 2026-10-12 alone the two exact pins either side of it make this unfallible — break either
    // helper and one of them fires first, so a single-week version would be decoration. Across
    // weeks nobody has pinned, with a DST change and a year boundary among them, it is the only
    // assertion here that still has anything to catch.
    for (const monday of ["2026-01-05", "2026-04-27", "2026-06-08", "2026-10-12", "2026-12-28"]) {
      const grace = planDeductionGraceDeadlineForMonday(monday);
      const onTime = submissionDeadlineForWeek(buildWeekKey(monday));
      assert.ok(
        grace.getTime() > onTime.getTime(),
        `${monday}: the deduction's grace deadline (${format(grace)}) must fall AFTER the planning module's on-time deadline (${format(onTime)}) for the same week — being late there is a planning flag, missing this one costs a day's pay`,
      );
    }
  }

  // ── WHO OWES ONE — head office allow-list, nobody else ────────────────────
  {
    for (const title of ["Product Manager", "product manager", "Group Product Manager"]) {
      assert.equal(owesAWeeklyPlan(title), true, `${title} owes a weekly plan`);
    }
    for (const title of [
      "Medical Representative", "District Sales Manager", "Senior District Manager",
      "National Sales Manager", "Regional Sales Manager", "Marketing Manager", "SFE Manager",
      "HR Manager", "CEO", "Admin Assistant", "Buffet", "QPPV", "Regulatory Affairs Supervisor",
      "Talent Acquisition", "R&D Manager", "Financial Advisor", null, "",
    ]) {
      assert.equal(owesAWeeklyPlan(title), false, `${title ?? "(none)"} must NOT be charged for a weekly plan`);
    }
    // And the filter actually runs: an out-of-scope title yields nothing even with no plan at all.
    assert.deepEqual(select({ roster: [person("B-1", "HR Manager")] }), [], "an out-of-scope person is never charged");
  }

  // ── THE HAPPY PATH — one missed week, one day, one day's pay ──────────────
  {
    const drafts = select({ roster: [person("A-10", "Product Manager")], onTimePlans: [{ weekKey: "2026-W42", hrId: "A-10" }] });
    assert.equal(drafts.length, 1, "the week with a plan is clear; the week without it is charged once");
    const [draft] = drafts;
    assert.equal(draft.category, "no_weekly_plan");
    assert.deepEqual(draft.dates, ["2026-10-12"], "the charge lands on that week's Monday");
    assert.equal(draft.rawValue, 1);
    assert.equal(draft.estimatedAmount, 1000);
    assert.match(String(draft.reason), /2026-W41/, "the reason names the week");

    const clipped = clipDraftToRange(draft, "2026-10-01", "2026-10-15");
    assert.ok(clipped, "the Monday survives a range that contains it");
    assert.equal(clipped.amount, 1000);
    assert.equal(clipDraftToRange(draft, "2026-10-13", "2026-10-31"), null, "a range after the Monday drops it");
  }

  // ── A LATE PLAN IS NOT A SUBMISSION ───────────────────────────────────────
  {
    // Only W42 was in on time, so W41 is charged — the loader is what tests submitted_at against
    // the deadline, and anything later never reaches onTimePlans.
    const charged = select({ roster: [person("A-10", "Product Manager")], onTimePlans: [{ weekKey: "2026-W42", hrId: "A-10" }] });
    assert.deepEqual(charged.map((d) => d.dates[0]), ["2026-10-12"]);
    const clear = select({
      roster: [person("A-10", "Product Manager")],
      onTimePlans: [{ weekKey: "2026-W41", hrId: "A-10" }, { weekKey: "2026-W42", hrId: "A-10" }],
    });
    assert.deepEqual(clear, [], "both weeks in on time means nothing is charged");
  }

  // ── THE FOUR GUARDS — each one alone must clear the week ──────────────────
  {
    const roster = [person("A-10", "Product Manager")];
    // Sanity: with no guard tripped, both weeks are charged.
    assert.equal(select({ roster }).length, 2, "sanity: two missed weeks are two charges");

    // 1. Not retroactive.
    assert.deepEqual(select({ roster, policyFirstMonday: "2026-11-02" }), [], "a week before the policy floor is never charged");
    assert.equal(WEEKLY_PLAN_POLICY_FIRST_MONDAY, "2026-10-12", "the shipped floor is the Monday he asked for the rule");

    // 2. Approved leave on the Monday.
    assert.deepEqual(
      select({ roster, approvedLeave: [["A-10", ["2026-10-12"]]] }).map((d) => d.dates[0]),
      ["2026-10-19"],
      "the Monday on approved leave is cleared and the other week still charges",
    );

    // 3. Employment span.
    assert.deepEqual(
      select({ roster: [person("A-10", "Product Manager", { hireDate: "2026-10-15" })] }).map((d) => d.dates[0]),
      ["2026-10-19"],
      "a Monday before the hire date is never charged",
    );
    assert.deepEqual(
      select({ roster: [person("A-10", "Product Manager", { endDate: "2026-10-14" })] }).map((d) => d.dates[0]),
      ["2026-10-12"],
      "a Monday after the leaving date is never charged",
    );

    // 4. No salary basis.
    assert.deepEqual(select({ roster, salaryEntries: [["A-10", null]] }), [], "no base salary means no salary-based deduction");
    assert.deepEqual(select({ roster, salaryEntries: [] }), [], "absent from the salary map is the same answer");
  }

  // ── THE MONDAYS OF A MONTH ────────────────────────────────────────────────
  {
    assert.deepEqual(
      mondaysInMonth({ month: 10, year: 2026 }).map((week) => week.mondayIso),
      ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"],
      "October 2026's Mondays, so a week straddling month end is charged once in one month",
    );
    assert.equal(mondaysInMonth({ month: 10, year: 2026 })[1].weekKey, "2026-W41", "12 Oct 2026 belongs to 2026-W41");
  }

  // ── THE COLUMN NAMES THE LOADER ASKS FOR ──────────────────────────────────
  {
    // A PostgREST select is a STRING: a column that does not exist fails the WHOLE read with
    // 42703, the fail-closed throw turns it into "Failed to load the weekly-plan roster", and
    // neither the compiler nor a green suite sees it. `employees` has `last_working_date`; it has
    // never had `end_date` (read live 2026-10-12, which is how the first draft was caught).
    const loader = readFileSync(new URL("../src/lib/daily-deductions/no-weekly-plan.ts", import.meta.url), "utf8");
    const select = loader.match(/\.select\("hr_id[^"]*"\)/)?.[0] ?? "";
    assert.match(select, /last_working_date/, "the roster must read last_working_date");
    assert.equal(/\bend_date\b/.test(select), false, "employees has no end_date column — that select fails whole");
    for (const column of ["hr_id", "full_name", "job_title", "hire_date"]) {
      assert.ok(select.includes(column), `the roster select must still name ${column}`);
    }
  }

  // ── WIRING ────────────────────────────────────────────────────────────────
  {
    assert.ok((dailyDeductionCategories as readonly string[]).includes("no_weekly_plan"));
    assert.ok(dailyDeductionConnectorLabels.no_weekly_plan.length > 0, "the connector has a human label");
    assert.match(
      readFileSync(new URL("../src/lib/daily-deductions/service.ts", import.meta.url), "utf8"),
      /no_weekly_plan:\s*\(input\)\s*=>\s*collectNoWeeklyPlanCandidates\(input\)/,
      "service.ts runs the no-weekly-plan collector",
    );
  }
}

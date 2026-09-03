import { strict as assert } from "node:assert";

import {
  buildAttendancePolicyExplainer,
  clockFromMinutes,
  durationFromMinutes,
  formatDeductionDays,
  type PolicyExplainerRuleRow,
} from "../src/lib/attendance/policy-explainer.ts";

// The live production shapes, so this test fails if the card ever stops describing the
// policies real employees are actually on.
//   4 -> the default flexible-hours policy (09:00, 30 min flex, 7h50m required)
//   3 -> a legacy grace-period policy, no required_minutes, and NO early_leave rules
//   6 -> a legacy grace-period policy that does have early_leave rules
const FLEX_POLICY = {
  effective_from: "2026-06-13",
  effective_to: null,
  flex_minutes: 30,
  grace_minutes: 10,
  half_day_split_minutes: 780,
  id: 4,
  is_active: true,
  judgment_mode: "every_working_day" as const,
  policy_name: "Default Attendance Policy",
  required_minutes: 470,
  scheduled_end: "17:30:00",
  scheduled_start: "09:00:00",
  target_type: "default",
  target_value: null,
  working_weekdays: null,
};

const GRACE_POLICY_NO_EARLY_LEAVE = {
  ...FLEX_POLICY,
  flex_minutes: 0,
  id: 3,
  policy_name: "A-8 office policy",
  required_minutes: null,
  scheduled_end: "16:00:00",
  scheduled_start: "10:00:00",
  target_type: "employee_hr_id",
  target_value: "A-8",
};

const ACTION_FOR_DEDUCTION: Record<string, string> = {
  "0.1250": "Deduct eighth day",
  "0.25": "Deduct quarter day",
  "0.50": "Deduct half day",
  "1.00": "Deduct full day",
};

// Typed, deliberately. The explainer feeds two engines with different input shapes, and
// an untyped fixture hid that from every local run: the tests passed while `typecheck`
// failed, because the test runner strips types. `PolicyExplainerRuleRow` is the contract.
const rule = (
  policyId: number,
  eventType: string,
  fromMinutes: number,
  toMinutes: number | null,
  deductionDays: string,
): PolicyExplainerRuleRow => ({
  deduction_days: deductionDays,
  event_type: eventType,
  from_minutes: fromMinutes,
  is_active: true,
  policy_id: policyId,
  recommended_action: ACTION_FOR_DEDUCTION[deductionDays] ?? null,
  to_minutes: toMinutes,
});

const RULES = [
  // Policy 4 — eighth / quarter / half, with nothing at all below 16 minutes.
  // 0.1250 is what production holds since the numeric(8,4) widening; before it, scale 2
  // forced 0.13 and a halved eighth came out as 0.065 of a day.
  rule(4, "late", 16, 30, "0.1250"),
  rule(4, "late", 31, 45, "0.25"),
  rule(4, "late", 46, null, "0.50"),
  rule(4, "short_hours", 16, 30, "0.1250"),
  rule(4, "short_hours", 31, 45, "0.25"),
  rule(4, "short_hours", 46, null, "0.50"),
  // Policy 3 — a DIFFERENT scale, deliberately, so cross-policy bleed is detectable.
  rule(3, "late", 16, 30, "0.25"),
  rule(3, "late", 31, 45, "0.50"),
  rule(3, "late", 46, null, "1.00"),
  rule(3, "short_hours", 16, 30, "0.25"),
];

const build = (policy: unknown, rules: PolicyExplainerRuleRow[] = RULES) =>
  buildAttendancePolicyExplainer({
    policy: policy as never,
    referenceDate: "2026-09-03",
    rules,
  });

export function runAttendancePolicyExplainerTests() {
  // ── Formatting ────────────────────────────────────────────────────────────
  assert.equal(clockFromMinutes(555), "9:15");
  assert.equal(clockFromMinutes(1025), "17:05");
  assert.equal(durationFromMinutes(470), "7h50m");
  assert.equal(durationFromMinutes(420), "7h00m");

  assert.equal(formatDeductionDays(0), "None");
  assert.equal(formatDeductionDays(1), "Full day");
  assert.equal(formatDeductionDays(0.5), "1/2 day");
  assert.equal(formatDeductionDays(0.25), "1/4 day");
  // A value that is not a clean fraction must be stated exactly, never rounded into
  // one — an employee told "1/8 day" when 0.065 is charged has been misinformed.
  assert.equal(formatDeductionDays(0.065), "0.065 day");

  // ── The flexible-hours card ───────────────────────────────────────────────
  const flex = build(FLEX_POLICY);
  assert.ok(flex, "the default policy must produce a card");
  assert.equal(flex.model, "flexible");
  assert.equal(flex.rows.length, 5);

  // The header states the real config, derived from scheduled_start + flex_minutes.
  assert.ok(flex.facts.includes("start 9:00"));
  assert.ok(flex.facts.includes("flex ceiling 9:30"));
  assert.ok(flex.facts.includes("minimum 7h50m"));

  // Row 1 and 2: on time, full hours, nothing owed. Arriving AT the ceiling is not late.
  assert.equal(flex.rows[0].deduction, "None");
  assert.equal(flex.rows[0].hasDeduction, false);
  assert.equal(flex.rows[1].clockIn, "9:30");
  assert.equal(flex.rows[1].deduction, "None");

  // Row 3: 30 min late but the hours were completed, so the penalty is HALVED.
  // An eighth halved is a clean sixteenth, and the card names both halves of that.
  assert.equal(flex.rows[2].clockIn, "10:00");
  assert.equal(flex.rows[2].late, "30 min");
  assert.equal(flex.rows[2].short, "0 (made it up)");
  assert.equal(flex.rows[2].deduction, "1/16 day");
  assert.equal(flex.rows[2].deductionNote, "1/8 day halved");

  // Row 4: both late and short — the WORSE of the two applies, never both.
  // Short 50 min -> 0.50; late 30 min -> 0.125. The short penalty wins.
  assert.equal(flex.rows[3].late, "30 min");
  assert.equal(flex.rows[3].short, "50 min");
  assert.equal(flex.rows[3].deduction, "1/2 day");
  assert.equal(flex.rows[3].deductionNote, "worse of the two");

  // Row 5: short only, and NOT late — 9:20 is inside the flex window.
  assert.equal(flex.rows[4].clockIn, "9:20");
  assert.equal(flex.rows[4].late, "0 (within flex)");
  assert.equal(flex.rows[4].short, "20 min");
  assert.equal(flex.rows[4].deduction, "1/8 day");

  // The dead zone below the first bracket is real policy and must be disclosed.
  assert.equal(flex.freeMinutes, 15);
  assert.ok(
    flex.rules.some((text) => text.includes("first 15 minutes")),
    "the free-minutes window must be stated in the rules",
  );

  // The scale shown is the policy's own.
  assert.deepEqual(
    flex.lateBrackets.map((bracket) => `${bracket.range}=${bracket.deduction}`),
    ["16-30 min=1/8 day", "31-45 min=1/4 day", "46 min or more=1/2 day"],
  );

  // ── Rules must never bleed between policies ───────────────────────────────
  // Policy 3's scale is quarter/half/full. If the explainer failed to scope rules by
  // policy id, policy 4's eighth would leak in here (and vice versa) — the exact defect
  // that makes a card contradict the payslip.
  const grace = build(GRACE_POLICY_NO_EARLY_LEAVE);
  assert.ok(grace, "a legacy grace policy must still produce a card");
  assert.equal(grace.model, "grace");
  assert.deepEqual(
    grace.lateBrackets.map((bracket) => bracket.deduction),
    ["1/4 day", "1/2 day", "Full day"],
  );
  assert.ok(
    !grace.lateBrackets.some((bracket) => bracket.deduction.includes("1/8")),
    "policy 4's scale must not appear on policy 3's card",
  );

  // The headline assertion for rule scoping, and the ONLY one that actually fires when
  // it breaks. `resolvePolicyAttendanceStatus` does not filter by policy id — it trusts
  // its caller to pass rules already scoped — so an unscoped set prices these rows off
  // whichever policy happens to sit first in the array. Policy 4's eighth would land here
  // in place of policy 3's own quarter day. The bracket assertions above do NOT catch
  // this: `bracketsForEventType` filters by policy id itself, so the displayed scale
  // stays right while the worked examples go wrong.
  assert.equal(grace.rows[2].late, "30 min");
  assert.equal(grace.rows[2].deduction, "1/4 day");
  assert.equal(grace.rows[3].deduction, "1/4 day");

  // The grace engine prices a shortfall off `early_leave`, not `short_hours`. Policy 3
  // has no early_leave rules at all, so its short scale is genuinely empty — the card
  // must show nothing rather than print the short_hours numbers it never charges.
  assert.deepEqual(grace.shortBrackets, []);

  // A grace policy is judged from the scheduled START, so the card says 10:00.
  assert.ok(grace.facts.includes("10:00 to 16:00"));
  assert.ok(grace.rules.some((text) => text.includes("Lateness is counted from 10:00")));

  // ── Refusals ──────────────────────────────────────────────────────────────
  // No policy, and a policy with no usable schedule, both yield no card rather than a
  // card describing a schedule nobody is on.
  assert.equal(build(null), null);
  assert.equal(build({ ...FLEX_POLICY, scheduled_start: null }), null);
}

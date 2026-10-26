// The attendance policy, explained to the person it is applied to.
//
// This module builds the worked-example table shown on the fingerprint pages so an
// employee can see, in their own schedule's numbers, what a late or short day
// actually costs them.
//
// The one rule that governs this file: it NEVER re-derives a deduction. Every number
// in the table comes back from the same two functions that settle real payroll —
// `evaluateFlexibleHoursDay` for policies on the flexible-hours model, and
// `resolvePolicyAttendanceStatus` for the two legacy grace-period policies that have
// no `required_minutes`. A second copy of the arithmetic here is exactly how a
// published policy card would quietly start contradicting the payslip.
//
// Consequence worth stating plainly: the examples are generated per policy, not
// hard-coded. An employee on the 10:00-16:00 policy sees 10:00-16:00 rows, and an
// edit to `attendance_policy_rules` reaches the card on the next render.

import {
  bracketsForEventType,
  evaluateFlexibleHoursDay,
  type AttendancePolicyRuleRow,
} from "@/lib/attendance/flexible-hours";
import {
  resolvePolicyAttendanceStatus,
  type AttendancePolicyRuleSelectionInput,
} from "@/lib/attendance/metrics";
import type { AttendanceFlexPolicyGroupDbRow } from "@/lib/attendance/policy-groups";
import { formatAttendanceWorkingWeekdays } from "@/lib/attendance/work-schedule";

/** Which engine settles this policy — the two differ enough to need different examples. */
export type AttendancePolicyModel = "flexible" | "grace";

/**
 * A rule row as this file needs it: the union of what BOTH engines demand.
 *
 * `policy_id` is what the flexible engine's bracket builder scopes on; `recommended_action`
 * is required by the grace engine's rule selection. Either type alone compiles against one
 * engine and fails the other, and the half that fails is the two legacy grace policies —
 * i.e. exactly the employees a narrower type would quietly stop describing.
 */
export type PolicyExplainerRuleRow = AttendancePolicyRuleRow & AttendancePolicyRuleSelectionInput;

export type PolicyExplainerRow = {
  clockIn: string;
  clockOut: string;
  /** Deduction text, e.g. "None", "1/4 day". */
  deduction: string;
  /** Parenthetical qualifier, e.g. "1/2 day halved". Empty when there is none. */
  deductionNote: string;
  /** True when the row costs the employee something — drives the emphasis in the UI. */
  hasDeduction: boolean;
  late: string;
  short: string;
  worked: string;
};

export type PolicyExplainerBracket = {
  deduction: string;
  /** e.g. "16-30 min" or "46 min or more". */
  range: string;
};

export type AttendancePolicyExplainer = {
  /** One-line chips under the title, in reading order. */
  facts: string[];
  /** Minutes past the ceiling that cost nothing. 0 when every late minute counts. */
  freeMinutes: number;
  lateBrackets: PolicyExplainerBracket[];
  model: AttendancePolicyModel;
  policyName: string;
  rows: PolicyExplainerRow[];
  /** Sentences describing the rules the table demonstrates. */
  rules: string[];
  shortBrackets: PolicyExplainerBracket[];
  title: string;
};

// --- Formatting -------------------------------------------------------------

/** 555 -> "9:15". 24-hour, hour unpadded, minute padded — the shape the owner's table uses. */
export function clockFromMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${Math.floor(wrapped / 60)}:${String(wrapped % 60).padStart(2, "0")}`;
}

/** 470 -> "7h50m". */
export function durationFromMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m`;
}

const DAY_FRACTION_WORDS = new Map<number, string>([
  [1, "Full day"],
  [0.5, "1/2 day"],
  [0.25, "1/4 day"],
  [0.125, "1/8 day"],
  [0.0625, "1/16 day"],
]);

/**
 * Renders a deduction in days. Known fractions get a phrase an employee can read;
 * anything else falls back to the exact decimal rather than being rounded away — a
 * policy row that produces 0.065 of a day should SAY 0.065, not be dressed up as a
 * clean fraction it is not.
 */
export function formatDeductionDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "None";
  const word = DAY_FRACTION_WORDS.get(Number(days.toFixed(4)));
  if (word) return word;
  return `${Number(days.toFixed(4))} day`;
}

function formatBracketRange(fromMinutes: number, toMinutes: number | null): string {
  if (toMinutes == null) return `${fromMinutes} min or more`;
  if (fromMinutes === toMinutes) return `${fromMinutes} min`;
  return `${fromMinutes}-${toMinutes} min`;
}

function toBrackets(
  rules: PolicyExplainerRuleRow[],
  policyId: number,
  eventType: string,
): PolicyExplainerBracket[] {
  return bracketsForEventType(rules, policyId, eventType).map((bracket) => ({
    deduction: formatDeductionDays(bracket.deductionDays),
    range: formatBracketRange(bracket.fromMinutes, bracket.toMinutes),
  }));
}

/**
 * Lateness below the first bracket's floor costs nothing — `bracketDeductionDays`
 * returns 0 for it. That dead zone is real policy an employee should be told about
 * rather than discover.
 */
function freeMinutesBelowFirstBracket(rules: PolicyExplainerRuleRow[], policyId: number): number {
  const brackets = bracketsForEventType(rules, policyId, "late");
  if (brackets.length === 0) return 0;
  return Math.max(0, brackets[0].fromMinutes - 1);
}

function policyTimeToMinutes(value: string | null | undefined): number | null {
  const [hourText, minuteText] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

// --- The flexible-hours table -----------------------------------------------

/**
 * The five scenarios the owner's policy table demonstrates, expressed as offsets so
 * they hold for any policy: on time, at the flex ceiling, late but made up, late AND
 * short, and short only.
 */
function flexibleRows(input: {
  ceilingMinutes: number;
  policy: AttendanceFlexPolicyGroupDbRow;
  requiredMinutes: number;
  rules: PolicyExplainerRuleRow[];
  startMinutes: number;
}): PolicyExplainerRow[] {
  const { ceilingMinutes, policy, requiredMinutes, rules, startMinutes } = input;
  const lateBrackets = bracketsForEventType(rules, policy.id, "late");
  const shortBrackets = bracketsForEventType(rules, policy.id, "short_hours");

  // Arrivals are clamped to the ceiling so the "on time" rows stay on time even on a
  // zero-flex policy, where start + 15 would already be late.
  const scenarios = [
    { arrive: Math.min(startMinutes + 15, ceilingMinutes), shortBy: 0 },
    { arrive: ceilingMinutes, shortBy: 0 },
    { arrive: ceilingMinutes + 30, shortBy: 0 },
    { arrive: ceilingMinutes + 30, shortBy: 50 },
    { arrive: Math.min(startMinutes + 20, ceilingMinutes), shortBy: 20 },
  ];

  return scenarios.map((scenario) => {
    const workedMinutes = Math.max(0, requiredMinutes - scenario.shortBy);
    const leave = scenario.arrive + workedMinutes;
    const result = evaluateFlexibleHoursDay({
      config: {
        flexCeilingMinutes: ceilingMinutes,
        requiredMinutes,
        scheduledStartMinutes: startMinutes,
      },
      firstPunchMinutes: scenario.arrive,
      lastPunchMinutes: leave,
      lateBrackets,
      shortBrackets,
      visiblePunchCount: 2,
    });

    const bothLateAndShort = result.lateMinutes > 0 && result.shortMinutes > 0;

    return {
      clockIn: clockFromMinutes(scenario.arrive),
      clockOut: clockFromMinutes(leave),
      deduction: formatDeductionDays(result.deductionDays),
      deductionNote:
        result.deductionDays <= 0
          ? ""
          : bothLateAndShort
            ? "larger penalty only"
            : result.halved
              ? `${formatDeductionDays(result.deductionDays * 2)} halved`
              : "",
      hasDeduction: result.deductionDays > 0,
      late:
        result.lateMinutes > 0
          ? `${result.lateMinutes} min`
          : scenario.arrive > startMinutes
            ? "0 (within flex)"
            : "0",
      short:
        result.shortMinutes > 0
          ? `${result.shortMinutes} min`
          : result.lateMinutes > 0
            ? "0 (made it up)"
            : "0",
      worked: durationFromMinutes(result.workedMinutes),
    };
  });
}

// --- The legacy grace-period table ------------------------------------------

/**
 * Two policy groups still run the older grace-period formula (`required_minutes` is
 * null). They are judged from the scheduled START, not a flex ceiling, and one grace
 * allowance covers lateness plus early leave together — so they need their own
 * examples. Showing these employees the flexible-hours table would be telling them a
 * rule that is not applied to them.
 */
function graceRows(input: {
  endMinutes: number;
  graceMinutes: number;
  policy: AttendanceFlexPolicyGroupDbRow;
  referenceDate: string;
  rules: PolicyExplainerRuleRow[];
  startMinutes: number;
}): PolicyExplainerRow[] {
  const { endMinutes, graceMinutes, policy, referenceDate, rules, startMinutes } = input;
  const scheduledMinutes = Math.max(0, endMinutes - startMinutes);
  const withinGrace = Math.max(1, graceMinutes);

  const scenarios = [
    { arrive: startMinutes, leave: endMinutes },
    { arrive: startMinutes + withinGrace, leave: endMinutes + withinGrace },
    { arrive: startMinutes + 30, leave: endMinutes + 30 },
    { arrive: startMinutes + 30, leave: endMinutes },
    { arrive: startMinutes, leave: endMinutes - 20 },
  ];

  return scenarios.map((scenario) => {
    const workedMinutes = Math.max(0, scenario.leave - scenario.arrive);
    const result = resolvePolicyAttendanceStatus({
      baseSalary: null,
      durationMinutes: workedMinutes,
      firstPunchMinutes: scenario.arrive,
      lastPunchMinutes: scenario.leave,
      policy,
      reportDate: referenceDate,
      rules,
      visiblePunchCount: 2,
    });

    const deductionDays = Number(result.deductionDays) || 0;
    const lateMinutes = Math.max(0, scenario.arrive - startMinutes);
    const earlyLeaveMinutes = Math.max(0, endMinutes - scenario.leave);
    const shortMinutes = Math.max(0, scheduledMinutes - workedMinutes);
    // The grace allowance is spent on lateness and early leave TOGETHER, so whether a
    // row is covered by it is decided on that combined figure — never on the deduction
    // being zero. A zero can also mean the policy simply has no rule for the event,
    // which is not the same thing and must not be labelled as grace.
    const graceUsage = Math.max(shortMinutes, lateMinutes + earlyLeaveMinutes);
    const withinGraceNote = graceUsage <= graceMinutes ? " (within grace)" : "";

    return {
      clockIn: clockFromMinutes(scenario.arrive),
      clockOut: clockFromMinutes(scenario.leave),
      deduction: formatDeductionDays(deductionDays),
      deductionNote: deductionDays > 0 && lateMinutes > 0 && shortMinutes > 0 ? "late and short" : "",
      hasDeduction: deductionDays > 0,
      late: lateMinutes > 0 ? `${lateMinutes} min${withinGraceNote}` : "0",
      short: shortMinutes > 0 ? `${shortMinutes} min${withinGraceNote}` : "0",
      worked: durationFromMinutes(workedMinutes),
    };
  });
}

// --- Entry point ------------------------------------------------------------

/**
 * The policy's name as its employee reads it. A policy written for ONE person (target_type
 * employee_hr_id) is stored under an administrator's label such as "Ali Elsayed (A-12)" — an HR id
 * and a spelling the portal never prints. That policy is introduced by the employee's portal display
 * name instead; every other policy keeps its stored name.
 */
export function explainerPolicyName(
  policy: { policy_name?: string | null; target_type?: string | null },
  employeeDisplayName?: string | null,
): string {
  if (policy.target_type === "employee_hr_id") {
    const name = employeeDisplayName?.trim();
    return name ? `Personal policy for ${name}` : "Your personal policy";
  }
  return policy.policy_name?.trim() || "Attendance policy";
}

/**
 * Builds the policy explainer for one resolved policy. Returns null when the employee
 * has no active policy, or the policy has no usable schedule — the caller then shows
 * nothing, because a card describing a policy nobody is on is worse than no card.
 */
export function buildAttendancePolicyExplainer(input: {
  /** The employee's portal display name — used only to introduce a policy written for him alone. */
  employeeDisplayName?: string | null;
  policy: AttendanceFlexPolicyGroupDbRow | null | undefined;
  /** Only affects money, which this card never shows — but the grace engine requires it. */
  referenceDate: string;
  rules: PolicyExplainerRuleRow[];
}): AttendancePolicyExplainer | null {
  const { policy, referenceDate, rules } = input;
  if (!policy) return null;

  const startMinutes = policyTimeToMinutes(policy.scheduled_start);
  const endMinutes = policyTimeToMinutes(policy.scheduled_end);
  if (startMinutes == null || endMinutes == null) return null;

  // Scope to THIS policy before anything reads the rules. `bracketsForEventType`
  // filters by policy id, but `resolvePolicyAttendanceStatus` does not — its caller in
  // the fingerprint report hands it rules that are already scoped. Passing an unscoped
  // set here would silently price an employee's day off another policy's scale, which
  // is precisely the divergence this file exists to prevent.
  const policyRules = rules.filter((rule) => rule.policy_id === policy.id && rule.is_active !== false);

  const policyName = explainerPolicyName(policy, input.employeeDisplayName);
  const workingDays = formatAttendanceWorkingWeekdays(policy.working_weekdays);
  const lateBrackets = toBrackets(policyRules, policy.id, "late");

  // The flexible-hours model — everyone whose policy carries a required presence.
  if (policy.required_minutes != null) {
    const requiredMinutes = policy.required_minutes;
    const ceilingMinutes = startMinutes + (policy.flex_minutes ?? 0);
    const freeMinutes = freeMinutesBelowFirstBracket(policyRules, policy.id);

    const facts = [
      `start ${clockFromMinutes(startMinutes)}`,
      `flex ceiling ${clockFromMinutes(ceilingMinutes)}`,
      `minimum ${durationFromMinutes(requiredMinutes)}`,
      `lateness counted from ${clockFromMinutes(ceilingMinutes)}`,
    ];
    if (workingDays) facts.push(workingDays);

    const rulesText = [
      `Arriving any time up to ${clockFromMinutes(ceilingMinutes)} is not late.`,
      `What is required is the presence, not the clock: ${durationFromMinutes(requiredMinutes)} between your first and last punch.`,
      "Completing the hours halves a late penalty.",
      "When a day is both late and short, only the larger penalty applies — never both.",
      "A day with a single punch is never auto-deducted; it goes for verification first.",
    ];
    if (freeMinutes > 0) {
      rulesText.splice(
        1,
        0,
        `The first ${freeMinutes} minutes past ${clockFromMinutes(ceilingMinutes)} carry no deduction.`,
      );
    }

    return {
      facts,
      freeMinutes,
      lateBrackets,
      model: "flexible",
      policyName,
      rows: flexibleRows({ ceilingMinutes, policy, requiredMinutes, rules: policyRules, startMinutes }),
      rules: rulesText,
      // The flexible engine prices a shortfall off `short_hours`.
      shortBrackets: toBrackets(policyRules, policy.id, "short_hours"),
      title: "Flexible working hours",
    };
  }

  // The legacy grace-period model.
  const graceMinutes = Math.max(0, policy.grace_minutes ?? 0);
  const facts = [
    `${clockFromMinutes(startMinutes)} to ${clockFromMinutes(endMinutes)}`,
    `grace ${graceMinutes} min`,
    `scheduled ${durationFromMinutes(Math.max(0, endMinutes - startMinutes))}`,
  ];
  if (workingDays) facts.push(workingDays);

  return {
    facts,
    freeMinutes: graceMinutes,
    lateBrackets,
    model: "grace",
    policyName,
    rows: graceRows({ endMinutes, graceMinutes, policy, referenceDate, rules: policyRules, startMinutes }),
    rules: [
      `Your day is ${clockFromMinutes(startMinutes)} to ${clockFromMinutes(endMinutes)}.`,
      `Lateness is counted from ${clockFromMinutes(startMinutes)}.`,
      `One allowance of ${graceMinutes} minutes covers lateness and early leave together.`,
      "Past that allowance, lateness is charged first; otherwise the shortfall is charged.",
      "A day with a single punch is never auto-deducted; it goes for verification first.",
    ],
    // The grace engine prices a shortfall off `early_leave`, NOT `short_hours` — see the
    // final branch of `resolvePolicyAttendanceStatus`. Showing the `short_hours` scale
    // here would print a number this employee is never actually charged.
    shortBrackets: toBrackets(policyRules, policy.id, "early_leave"),
    title: "Attendance policy",
  };
}

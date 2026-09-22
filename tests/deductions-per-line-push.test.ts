import assert from "node:assert/strict";

import {
  buildDeductionBuckets,
  candidateAmount,
  DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY,
} from "../src/lib/automated-payroll/deductions-source.ts";
import { resolvePublishedAppliedAmount } from "../src/lib/deductions/calculations.ts";
import { resolveDeductionNotificationCc } from "../src/lib/deductions/notify-deduction.ts";
import { pushDeduction, pushForEmployee, withdrawDeduction } from "../src/lib/deductions/push.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "../src/lib/deductions/types.ts";
import { buildOrgIndex, personKey, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Per-line deduction PUSH (owner rule 2026-09-22): deductions are functioning but
 * NEVER automatic. Three properties are pinned here, each the kind of failure that
 * only surfaces as real money on a payslip or a notice reaching the wrong person:
 *
 *   1. The manager-chain CC — a rep's deduction CCs DM + RSM + NSM, a DM's CCs
 *      RSM + NSM, the CEO is never CC'd, and a person with no sales seat CCs their
 *      flat direct manager. Nobody is ever CC'd on their own deduction.
 *   2. The payroll gate — from the push cutover, PUSH (not "Approved for Payroll")
 *      is what releases money, and the frozen line amount equals what payroll
 *      charges, so gating on push cannot move a figure.
 *   3. Super Admin only — every push/withdraw entry point refuses a non-Super-Admin
 *      before it touches the database.
 */

// --- a minimal seat, all columns present so buildOrgIndex is exercised for real ---
function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: null,
    occupantHrId: null,
    lineCode: "CNS",
    lineName: "CNS",
    areaName: "Area",
    regionName: "Region",
    seatLabel: overrides.tier,
    ...overrides,
  };
}

/**
 * CEO → NSM → RSM → DM → REP, one occupant each. `withRsm=false` leaves the RSM
 * seat vacant so the "Regional Manager only if present" branch is exercised too.
 */
function orgFixture(withRsm: boolean) {
  return buildOrgIndex([
    seat({ seatId: "CEO", tier: "CEO", path: ["CEO"], occupantHrId: "B-2" }),
    seat({ seatId: "NSM1", tier: "NSM", parentSeatId: "CEO", path: ["CEO", "NSM1"], occupantHrId: "N-1" }),
    seat({
      seatId: "RSM1",
      tier: "RSM",
      parentSeatId: "NSM1",
      path: ["CEO", "NSM1", "RSM1"],
      occupantHrId: withRsm ? "R-1" : null,
    }),
    seat({ seatId: "DM1", tier: "DM", parentSeatId: "RSM1", path: ["CEO", "NSM1", "RSM1", "DM1"], occupantHrId: "D-1" }),
    seat({
      seatId: "REP1",
      tier: "REP",
      parentSeatId: "DM1",
      path: ["CEO", "NSM1", "RSM1", "DM1", "REP1"],
      occupantHrId: "E-1",
    }),
  ]);
}

function candidate(overrides: {
  id?: string;
  category?: DeductionsCategory;
  compact?: string;
  rawValue?: number;
  estimatedAmount?: number | null;
  dates?: string[];
  unit?: "days" | "amount";
  status?: string | null;
  appliedAmount?: number | null;
  appliedValue?: number | null;
  appliedDates?: string[] | null;
}): DeductionsCandidateWithDecision {
  const dates = overrides.dates ?? ["2026-09-06", "2026-09-07"];
  return {
    id: overrides.id ?? `${overrides.category ?? "crm"}-${overrides.compact ?? "b1"}`,
    category: overrides.category ?? "crm",
    sourceSystem: "test",
    sourceRecordId: "rec",
    candidateKey: "key",
    employeeHrId: "B-1",
    employeeHrIdCompact: overrides.compact ?? "b1",
    employeeName: "Test Employee",
    monthKey: "2026-09",
    month: 9,
    year: 2026,
    unit: overrides.unit ?? "days",
    rawValue: overrides.rawValue ?? dates.length,
    estimatedAmount: overrides.estimatedAmount === undefined ? 1000 : overrides.estimatedAmount,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: "No CRM activity",
    evidence: {},
    dates,
    hierarchySnapshot: {},
    createdBy: "test",
    createdAt: "",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    hireDate: null,
    holidayBridges: [],
    decision:
      overrides.status === undefined
        ? null
        : {
            id: "d",
            candidateId: "c",
            decisionStatus: overrides.status as never,
            decisionReason: "",
            hrNote: "",
            appliedValue: overrides.appliedValue ?? null,
            appliedAmount: overrides.appliedAmount ?? null,
            appliedDates: overrides.appliedDates ?? null,
            decidedBy: "admin",
            decidedAt: "",
            actorRoleAtDecision: "Super Admin",
            createdAt: "",
            updatedAt: "",
          },
  } as unknown as DeductionsCandidateWithDecision;
}

export async function runDeductionsPerLinePushTests() {
  // ---------------------------------------------------------------------------
  // 1. The manager-chain CC.
  // ---------------------------------------------------------------------------
  const org = orgFixture(true);

  // A Medical Rep → District Manager + Regional Manager + National Sales Manager,
  // nearest first, and never the CEO. This is the owner's "also CC the Regional
  // Manager for a rep" spelled out.
  assert.deepEqual(
    resolveDeductionNotificationCc({ employeeHrId: "E-1", orgIndex: org }),
    [personKey("D-1"), personKey("R-1"), personKey("N-1")],
    "a rep's deduction CCs DM → RSM → NSM, nearest first, never the CEO",
  );

  // A District Manager → RSM + NSM (never their own seat, never the CEO).
  assert.deepEqual(
    resolveDeductionNotificationCc({ employeeHrId: "D-1", orgIndex: org }),
    [personKey("R-1"), personKey("N-1")],
    "a DM's deduction CCs the RSM and NSM above, not the DM themselves and not the CEO",
  );

  // Nobody is ever CC'd on their own deduction.
  for (const hrId of ["E-1", "D-1", "N-1"]) {
    assert.ok(
      !resolveDeductionNotificationCc({ employeeHrId: hrId, orgIndex: org }).includes(personKey(hrId)!),
      `${hrId} must never be CC'd on their own deduction`,
    );
  }

  // The CEO is never CC'd, whoever the subject.
  for (const hrId of ["E-1", "D-1", "N-1", "R-1"]) {
    assert.ok(
      !resolveDeductionNotificationCc({ employeeHrId: hrId, orgIndex: org }).includes(personKey("B-2")!),
      "the CEO is never on a deduction CC list",
    );
  }

  // The Regional Manager is CC'd only when the RSM seat is occupied — a vacant RSM
  // is skipped, not left as a gap that stalls the notice.
  assert.deepEqual(
    resolveDeductionNotificationCc({ employeeHrId: "E-1", orgIndex: orgFixture(false) }),
    [personKey("D-1"), personKey("N-1")],
    "a vacant Regional Manager seat is skipped — the rep's CC is then DM + NSM",
  );

  // An employee with no sales seat → their flat direct manager, and only them.
  assert.deepEqual(
    resolveDeductionNotificationCc({ employeeHrId: "OFFICE-1", orgIndex: org, directManagerHrId: "M-1" }),
    [personKey("M-1")],
    "an office employee with no sales seat CCs their direct manager (employees.manager_hr_id)",
  );
  assert.deepEqual(
    resolveDeductionNotificationCc({ employeeHrId: "OFFICE-1", orgIndex: org, directManagerHrId: null }),
    [],
    "no sales seat and no direct manager on file → nobody is CC'd, never a throw",
  );

  // ---------------------------------------------------------------------------
  // 2. The payroll gate: PUSH releases money, not "Approved for Payroll".
  // ---------------------------------------------------------------------------
  const approvedNotPushed = candidate({ id: "c-approved", category: "other", status: "Approved for Payroll", unit: "amount", estimatedAmount: 500 });
  const pendingButPushed = candidate({ id: "c-pending", category: "other", status: "Pending", unit: "amount", estimatedAmount: 700 });

  // Legacy mode (no pushedCandidateIds): the 2026-08-03 rule stands — approved counts, pending does not.
  const legacy = buildDeductionBuckets([approvedNotPushed, pendingButPushed]);
  assert.equal(legacy.get("b1")?.buckets.other, 500, "legacy gate: an approved amount reaches payroll");

  // Push mode: the ONLY thing that counts is being in the pushed set — decision
  // status is irrelevant. The approved-but-unpushed row pays nothing; the pushed
  // pending row pays.
  const pushed = buildDeductionBuckets([approvedNotPushed, pendingButPushed], {
    pushedCandidateIds: new Set(["c-pending"]),
  });
  assert.equal(
    pushed.get("b1")?.buckets.other,
    700,
    "push gate: only a PUSHED candidate reaches payroll — approval alone does not, a pushed row does",
  );

  // An empty pushed set (a month where nothing is pushed yet) deducts nothing,
  // even though a candidate is approved — the whole point of "never automatic".
  assert.equal(
    Object.values(buildDeductionBuckets([approvedNotPushed], { pushedCandidateIds: new Set<string>() }).get("b1")?.buckets ?? {})
      .reduce((sum, value) => sum + value, 0),
    0,
    "push gate: nothing pushed means nothing deducted, whatever is approved",
  );

  // pushedCandidateIds: null is legacy, identical to omitting it.
  assert.equal(
    buildDeductionBuckets([approvedNotPushed], { pushedCandidateIds: null }).get("b1")?.buckets.other,
    500,
    "a null pushed set falls back to the legacy approved-for-payroll gate",
  );

  // The cutover is 2026-09 and compares lexically (zero-padded YYYY-MM).
  assert.equal(DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY, "2026-09", "the push cutover month is September 2026");
  assert.ok("2026-08" < DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY, "August 2026 is before the cutover (legacy gate)");
  assert.ok("2026-09" >= DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY, "September 2026 is at the cutover (push gate)");
  assert.ok("2026-10" >= DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY, "October 2026 is after the cutover (push gate)");

  // ---------------------------------------------------------------------------
  // 2b. The money invariant that makes gating-only SAFE: the amount frozen onto a
  // pushed line (resolvePublishedAppliedAmount) equals what payroll charges
  // (candidateAmount). If these ever diverge, gating on push could move a figure.
  // ---------------------------------------------------------------------------
  const notNarrowed = candidate({ category: "crm", dates: ["2026-09-01", "2026-09-02"], rawValue: 2, estimatedAmount: 640, status: "Approved for Payroll" });
  assert.equal(
    resolvePublishedAppliedAmount(notNarrowed),
    candidateAmount(notNarrowed),
    "an approved, un-narrowed day candidate freezes the same amount payroll charges",
  );
  const narrowed = candidate({
    category: "crm",
    dates: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
    rawValue: 4,
    estimatedAmount: 800,
    status: "Approved for Payroll",
    appliedValue: 2,
    appliedAmount: 400,
  });
  assert.equal(
    resolvePublishedAppliedAmount(narrowed),
    candidateAmount(narrowed),
    "a narrowed candidate carries an appliedAmount both readers honour — no drift",
  );
  const amountUnit = candidate({ category: "loan", unit: "amount", estimatedAmount: 1250, status: "Approved for Payroll" });
  assert.equal(
    resolvePublishedAppliedAmount(amountUnit),
    candidateAmount(amountUnit),
    "a manual amount deduction freezes exactly what payroll charges",
  );

  // ---------------------------------------------------------------------------
  // 3. Super Admin only. Every entry point refuses a non-Super-Admin BEFORE it
  // touches the database (the assert runs first, so no production write occurs).
  // ---------------------------------------------------------------------------
  const notAdmin = { role: "CEO", hrId: "B-2", loginId: null } as const;
  await assert.rejects(
    () => pushForEmployee({ monthKey: "2026-09", employeeHrIdCompact: "b1", actor: notAdmin }),
    /Forbidden: only Super Admin/,
    "pushForEmployee refuses a non-Super-Admin",
  );
  await assert.rejects(
    () => pushDeduction({ monthKey: "2026-09", candidateId: "c-1", actor: notAdmin }),
    /Forbidden: only Super Admin/,
    "pushDeduction refuses a non-Super-Admin",
  );
  await assert.rejects(
    () => withdrawDeduction({ lineId: "line-1", actor: notAdmin }),
    /Forbidden: only Super Admin/,
    "withdrawDeduction refuses a non-Super-Admin",
  );
}

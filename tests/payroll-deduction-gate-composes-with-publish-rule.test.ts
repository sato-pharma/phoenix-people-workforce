import assert from "node:assert/strict";

import { buildDeductionBuckets, isConfirmedForPayroll } from "../src/lib/automated-payroll/deductions-source.ts";
import { isEligibleForPublish } from "../src/lib/deductions/calculations.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "../src/lib/deductions/types.ts";

/**
 * Pins that the two deduction gates COMPOSE, across the module boundary.
 *
 * Three PRs landed on 2026-08-03 from three different sessions, and nobody
 * checked they compose:
 *
 *  - #1653 added source `holiday_bridge`, filed under category `other`.
 *  - #1654 added source `dsm_no_record`, filed under category `crm`, plus the
 *    `ALWAYS_REQUIRE_APPROVAL_SOURCE_SYSTEMS` override in
 *    `isEligibleForPublish` — the owner's "never auto publish" rule for
 *    district-manager no-record days.
 *  - #1657 rewired Automated Payroll to read the Deductions module, and
 *    deliberately did NOT call `isEligibleForPublish`. It uses its own,
 *    stricter `isConfirmedForPayroll`: approved, or nothing.
 *
 * THE INVARIANT. Payroll must never release money the module itself would
 * refuse to publish:
 *
 *     isConfirmedForPayroll(c)  ⟹  isEligibleForPublish(c)
 *
 * That holds today, but only as an EMERGENT property of two independently
 * maintained functions in two different domains, with nothing connecting them.
 * `deductions-source.ts` re-derives eligibility rather than delegating, and
 * this module has a documented history of exactly that costing real money —
 * Overview and publish disagreeing (~384k vs ~118k EGP) because two copies of
 * one rule drifted. This file is the connection.
 *
 * WHY IT IS NOT ENOUGH to test payroll's gate alone (which
 * automated-payroll-reads-deductions-module.test.ts already does well): that
 * suite builds every fixture with `sourceSystem: "test"`. Neither new source
 * system appears in it. A gate that keys on SOURCE cannot be pinned by fixtures
 * that never vary the source.
 *
 * The live row this protects, measured on production 2026-08-04: July holds one
 * PENDING `dsm_no_record` candidate worth 8,709.68 EGP. Nothing is published
 * yet, so nothing has been paid wrongly — this is preventative.
 */

/** Every decision state the module can hold, plus one it has never heard of. */
const ALL_STATUSES = [
  "Pending",
  "Approved for Payroll",
  "Do Not Take Action",
  "Needs Follow-up",
  "Disputed",
  "Some Future Status",
] as const;

const ALL_CATEGORIES: DeductionsCategory[] = [
  "fingerprint",
  "crm",
  "crm_half_day",
  "no_records_activity",
  "no_weekly_plan",
  "unpaid_vacation",
  "insufficient_balance_vacation",
  "loan",
  "other",
  "field_review",
];

/** Every source system that currently writes candidates, plus an unknown one. */
const ALL_SOURCE_SYSTEMS = [
  "crm_visits_mirror",
  "crm_vacation_signal",
  "fingerprint_report",
  "vacation_balance",
  "manual_hr",
  "dsm_no_record",
  "holiday_bridge",
  "crm_half_day",
  "hr_ops_report",
  "some_future_connector",
] as const;

function candidate(overrides: {
  category: DeductionsCategory;
  sourceSystem: string;
  status?: string | null;
  compact?: string;
  estimatedAmount?: number | null;
}): DeductionsCandidateWithDecision {
  return {
    id: `${overrides.sourceSystem}-${overrides.category}-${overrides.status ?? "none"}`,
    category: overrides.category,
    sourceSystem: overrides.sourceSystem,
    sourceRecordId: "rec",
    candidateKey: "key",
    employeeHrId: "B-1",
    employeeHrIdCompact: overrides.compact ?? "b1",
    employeeName: "Test Employee",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: "amount",
    rawValue: 1,
    estimatedAmount: overrides.estimatedAmount === undefined ? 1000 : overrides.estimatedAmount,
    calculationStatus: "calculated",
    severity: "High",
    reason: "test",
    evidence: {},
    dates: ["2026-07-06"],
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
            appliedValue: null,
            appliedAmount: null,
            appliedDates: null,
            decidedBy: "admin",
            decidedAt: "",
            actorRoleAtDecision: "Super Admin",
            createdAt: "",
            updatedAt: "",
          },
  } as unknown as DeductionsCandidateWithDecision;
}

/** Total money a candidate would put on a payroll sheet, across every bucket. */
function payrollTotal(row: DeductionsCandidateWithDecision): number {
  const buckets = buildDeductionBuckets([row]).get("b1")?.buckets;
  return Object.values(buckets ?? {}).reduce((sum, value) => sum + value, 0);
}

export function runPayrollDeductionGateComposesWithPublishRuleTests() {
  // ---- THE CROSS-MODULE INVARIANT, over the whole input space --------------
  // Exhaustive rather than sampled: the failure being guarded is a rule that
  // holds for the cases someone thought of and breaks for the one they did not.
  //
  // Asserted against buildDeductionBuckets — the function that actually puts
  // money on a sheet — NOT against isConfirmedForPayroll. The gate is applied
  // INSIDE buildDeductionBuckets, so a change made there rather than in the
  // helper would sail past a test that only questioned the helper. (Confirmed
  // the hard way: an earlier draft of this file checked the helper, and stayed
  // green while a deliberately broken bucket-builder paid out a pending row.)
  for (const category of ALL_CATEGORIES) {
    for (const sourceSystem of ALL_SOURCE_SYSTEMS) {
      for (const status of ALL_STATUSES) {
        const row = candidate({ category, sourceSystem, status });
        if (payrollTotal(row) === 0) continue;
        assert.ok(
          isEligibleForPublish(row),
          `payroll would pay a ${sourceSystem}/${category} row at "${status}" that the Deductions module refuses to publish — payroll must never be the looser of the two gates`,
        );
      }
    }
  }

  // The helper and the path that spends it must agree, so neither can be
  // relaxed on its own without this file noticing.
  for (const category of ALL_CATEGORIES) {
    for (const status of ALL_STATUSES) {
      const row = candidate({ category, sourceSystem: "manual_hr", status });
      assert.equal(
        payrollTotal(row) > 0,
        isConfirmedForPayroll(row),
        `buildDeductionBuckets must gate on isConfirmedForPayroll and nothing else — a ${category} row at "${status}" disagrees with the helper that documents the rule`,
      );
    }
  }

  // ---- "NEVER AUTO PUBLISH" SURVIVES INTO PAYROLL (#1654 ⨯ #1657) ----------
  // dsm_no_record sits in the `crm` category, which is mandatory-unless-cleared.
  // The module's override keys on SOURCE SYSTEM, not category. Payroll re-derives
  // eligibility instead of delegating, so it must reach the same answer without
  // ever seeing that override.
  for (const status of ["Pending", "Needs Follow-up", "Disputed", "Do Not Take Action"] as const) {
    const dsm = candidate({ category: "crm", sourceSystem: "dsm_no_record", status });
    assert.equal(
      isEligibleForPublish(dsm),
      false,
      `a "${status}" district-manager no-record day must not publish — the owner's rule is that these are NEVER auto-published`,
    );
    assert.equal(
      payrollTotal(dsm),
      0,
      `a "${status}" district-manager no-record day must reach NO payroll sheet — this is the live July row worth 8,709.68 EGP, and it sits in the CRM category that pays a rep's day without any approval at all`,
    );
  }
  assert.equal(
    payrollTotal(candidate({ category: "crm", sourceSystem: "dsm_no_record", status: "Approved for Payroll" })),
    1000,
    "an explicitly approved district-manager day must still be paid — a gate that withholds confirmed money is the opposite failure",
  );

  // The rep rows the override deliberately leaves alone: still mandatory for
  // PUBLISH, still approval-only for PAYROLL. Both halves matter — this is the
  // one place the two gates legitimately disagree, and the disagreement must
  // point at payroll being stricter.
  const pendingRep = candidate({ category: "crm", sourceSystem: "crm_visits_mirror", status: "Pending" });
  assert.equal(
    isEligibleForPublish(pendingRep),
    true,
    "a rep's pending CRM day is mandatory-unless-cleared for publish — #1654 must not have changed the long-standing rep behaviour",
  );
  assert.equal(
    payrollTotal(pendingRep),
    0,
    "...but payroll pays only what HR confirmed, so the same row deducts nothing — the owner's 2026-08-03 rule after an undecided CRM row would have charged 8,709.68 EGP with no decision behind it",
  );

  // ---- holiday_bridge REACHES A BUCKET (#1653 ⨯ #1657) ---------------------
  // Filed under `other`, whose salary column is other_deductions. The risk is
  // not overcharging but a SILENT DROP: a confirmed deduction that lands in no
  // bucket is money the company simply never collects, with nothing on screen
  // to show it went missing.
  const bridge = candidate({ category: "other", sourceSystem: "holiday_bridge", status: "Approved for Payroll" });
  const bridgeBuckets = buildDeductionBuckets([bridge]).get("b1")?.buckets;
  assert.equal(
    bridgeBuckets?.other,
    1000,
    "a confirmed governmental-holiday bridging day must land in the `other` bucket — its category maps to the other_deductions salary column",
  );
  assert.equal(
    payrollTotal(bridge),
    1000,
    "...and must not be double-counted into a second bucket on the way",
  );
  assert.equal(
    payrollTotal(candidate({ category: "other", sourceSystem: "holiday_bridge", status: "Pending" })),
    0,
    "an undecided bridging day pays nothing — `other` requires an explicit approval in the module too",
  );

  // ---- EVERY category still reaches SOME bucket ----------------------------
  // bucketFor() is a hand-maintained mirror of DEDUCTIONS_CATEGORY_CONFIG's
  // salaryRecordsColumn. A category that falls through it is silently dropped
  // rather than loudly failing, so an approved row of every category must
  // produce exactly its own amount.
  for (const category of ALL_CATEGORIES) {
    assert.equal(
      payrollTotal(candidate({ category, sourceSystem: "manual_hr", status: "Approved for Payroll" })),
      1000,
      `a confirmed ${category} deduction must land in a payroll bucket — an unmapped category is money that silently disappears between the module and the sheet`,
    );
  }

  // ---- an unknown source system must not widen either gate -----------------
  assert.equal(
    payrollTotal(candidate({ category: "crm", sourceSystem: "some_future_connector", status: "Pending" })),
    0,
    "a connector nobody has written yet must not be able to deduct without an approval — payroll's gate reads the decision, never the source's reputation",
  );
}

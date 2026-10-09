import assert from "node:assert/strict";

import { reconcileDeductions } from "../src/lib/automated-payroll/deduction-reconciliation.ts";
import { buildDeductionBuckets } from "../src/lib/automated-payroll/deductions-source.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";
import type { DeductionsCandidateWithDecision } from "../src/lib/deductions/types.ts";

/**
 * Guards the one reading of a RETIRED approval that is honest in both directions.
 *
 * WHAT WENT WRONG (owner, 2026-10-09: "fix the reconcile tool to count a superseded approval").
 * The reconciliation asked "does this run charge what the module approved?" against the module as
 * it looks TODAY. The August 2026 run was published on 8 September; two of its unpaid-vacation
 * approvals were retired afterwards — one on 10 September, one on 8 OCTOBER, a month after the
 * money was paid. The report called the run over-charged by 934.74 EGP on figures that were
 * approved, live and correct when the sheet was frozen.
 *
 * WHY THE OBVIOUS FIX IS WORSE THAN THE BUG. "Count every retired approval" reads money the
 * module has WITHDRAWN back onto the sheet. Measured on production the same day: of 94 retired
 * approvals, 93 have no replacement candidate at all — the source itself withdrew the row, an
 * unpaid day corrected to paid or a fingerprint day excused. Counting those would report a run as
 * correct for charging money nobody stands behind, which is the failure direction that costs an
 * employee real pay.
 *
 * So the rule is a CUT-OFF, not a flag: an approval counts if it was live and approved at the
 * instant the run's figures could no longer move. Three things must hold, and each is asserted
 * below because each has its own way of going wrong:
 *
 *   1. Nothing changes for any money path. `buildDeductionBuckets` feeds the live recommenders;
 *      if a retired approval ever counts WITHOUT the caller asking, the module starts charging
 *      withdrawn deductions. This is the assertion that matters most.
 *   2. Retired AFTER the freeze counts; retired BEFORE it does not.
 *   3. A retirement whose decision was carried onto a live replacement counts ONCE.
 */

const compact = (hrId: string) => hrId.toLowerCase().replace(/[^a-z0-9]+/g, "");

function candidate(overrides: {
  id: string;
  compact?: string;
  status?: string | null;
  estimatedAmount?: number;
  supersededAt?: string | null;
  supersededByCandidateId?: string | null;
}): DeductionsCandidateWithDecision {
  return {
    id: overrides.id,
    category: "unpaid_vacation",
    sourceSystem: "test",
    sourceRecordId: overrides.id,
    candidateKey: overrides.id,
    employeeHrId: "B-172",
    employeeHrIdCompact: overrides.compact ?? "b172",
    employeeName: "Yathreb El Ghannam",
    monthKey: "2026-08",
    month: 8,
    year: 2026,
    unit: "days",
    rawValue: 1,
    estimatedAmount: overrides.estimatedAmount ?? 483.87,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: "Unpaid vacation day",
    evidence: {},
    dates: ["2026-08-25"],
    hierarchySnapshot: {},
    createdBy: "test",
    createdAt: "",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: overrides.supersededAt ?? null,
    supersededByCandidateId: overrides.supersededByCandidateId ?? null,
    hireDate: null,
    holidayBridges: [],
    decision:
      overrides.status === undefined
        ? null
        : {
            id: `d-${overrides.id}`,
            candidateId: overrides.id,
            decisionStatus: overrides.status as never,
            decisionReason: "",
            hrNote: "",
            appliedValue: null,
            appliedAmount: null,
            appliedDates: null,
            decidedBy: "B-10",
            decidedAt: "2026-09-04T16:30:00.000Z",
            actorRoleAtDecision: "Super Admin",
            createdAt: "",
            updatedAt: "",
          },
  } as unknown as DeductionsCandidateWithDecision;
}

/** The August 2026 run's real shape: Part 1 confirmed 30 Aug, published 8 Sep. */
const FROZEN_AT = "2026-09-08T11:43:39.675+00:00";
const RETIRED_AFTER_THE_FREEZE = "2026-10-08T16:48:13.330+00:00";
const RETIRED_BEFORE_THE_FREEZE = "2026-09-01T09:00:00.000Z";

const vacationBucket = (candidates: DeductionsCandidateWithDecision[], cutoff?: string | null) =>
  buildDeductionBuckets(
    candidates,
    cutoff === undefined ? undefined : { countSupersededApprovedAfter: cutoff },
  ).get("b172")?.buckets.unpaidVacation ?? 0;

export function runReconcileCountsRetiredApprovalTests() {
  const retiredApproval = candidate({
    id: "retired-approved",
    status: "Approved for Payroll",
    supersededAt: RETIRED_AFTER_THE_FREEZE,
  });

  // ---- 1. EVERY MONEY PATH IS UNCHANGED ------------------------------------
  // No option passed is how recommend.ts, run-service.ts, step-definitions.ts and
  // module-sourced-steps.ts all call this. A retired approval must contribute NOTHING there, or
  // the sheet begins charging deductions the module has withdrawn.
  assert.equal(
    vacationBucket([retiredApproval]),
    0,
    "a RETIRED approval must contribute 0.00 when the caller did not ask for retired approvals — " +
      "this is the call every money path makes, and counting it there charges withdrawn money",
  );
  assert.equal(
    vacationBucket([retiredApproval], null),
    0,
    "a null cut-off must behave exactly like no cut-off — an unpublished run has no freeze instant",
  );

  // ---- 2. THE CUT-OFF, IN BOTH DIRECTIONS ----------------------------------
  assert.equal(
    vacationBucket([retiredApproval], FROZEN_AT),
    483.87,
    "an approval retired AFTER the run was frozen explains what the run charges, so it must count",
  );
  assert.equal(
    vacationBucket(
      [
        candidate({
          id: "retired-early",
          status: "Approved for Payroll",
          supersededAt: RETIRED_BEFORE_THE_FREEZE,
        }),
      ],
      FROZEN_AT,
    ),
    0,
    "an approval retired BEFORE the freeze was already withdrawn when the sheet was built — " +
      "counting it would report a charge of withdrawn money as correct",
  );

  // Fails closed on the decision, same as every other path into a bucket.
  assert.equal(
    vacationBucket(
      [candidate({ id: "retired-pending", status: "Pending", supersededAt: RETIRED_AFTER_THE_FREEZE })],
      FROZEN_AT,
    ),
    0,
    "a retired candidate that was never approved must still contribute 0.00",
  );

  // ---- 3. COUNTED ONCE, NEVER TWICE ----------------------------------------
  // The carry-forward in reconcileCandidates hands an approval to its replacement. Both rows then
  // read "Approved for Payroll", and counting both doubles the employee's deduction.
  assert.equal(
    vacationBucket(
      [
        candidate({
          id: "old",
          status: "Approved for Payroll",
          supersededAt: RETIRED_AFTER_THE_FREEZE,
          supersededByCandidateId: "new",
        }),
        candidate({ id: "new", status: "Approved for Payroll" }),
      ],
      FROZEN_AT,
    ),
    483.87,
    "a carried approval must be counted ONCE — the live replacement already carries it, and " +
      "counting the retired row too doubles the charge",
  );

  // The production shape: the replacement exists but came back undecided, so only the retired row
  // carries the approval. This is Aya Abdullah's August row.
  assert.equal(
    vacationBucket(
      [
        candidate({
          id: "old",
          status: "Approved for Payroll",
          supersededAt: RETIRED_AFTER_THE_FREEZE,
          supersededByCandidateId: "new",
          estimatedAmount: 451.61,
        }),
        candidate({ id: "new", status: "Pending", estimatedAmount: 451.61 }),
      ],
      FROZEN_AT,
    ),
    451.61,
    "when the replacement came back undecided the retired row is the only one holding the " +
      "approval, so it must count",
  );

  // ---- 4. THE REPORT SAYS SO -----------------------------------------------
  // A module total nobody can reproduce from the Deductions screen has to explain itself.
  const deductions = buildDeductionBuckets([retiredApproval], {
    countSupersededApprovedAfter: FROZEN_AT,
  });
  const member: PopulationMember = {
    employee: { hrId: "B-172", fullName: "Yathreb El Ghannam" } as unknown as EmployeeDirectoryRow,
    compact: compact("B-172"),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  } as PopulationMember;
  const source = { paymentMode: "two_parts" } as unknown as PayrollSalarySource;
  const draftRow = (patch: Partial<DraftRow>): DraftRow =>
    ({
      runId: "run-aug",
      employeeHrId: "B-172",
      employeeHrIdCompact: compact("B-172"),
      fingerprintValue: null,
      crm: null,
      unpaidVacations: null,
      manualOtherDeductions: null,
      p1odCrmValue: null,
      p1odVacationValue: null,
      p1odLoanValue: null,
      p1odOtherValue: null,
      settledInPart1: false,
      ...patch,
    }) as unknown as DraftRow;
  const report = reconcileDeductions({
    members: [member],
    sources: new Map([["b-172", source], [compact("B-172"), source]]),
    deductions,
    draftRows: [draftRow({ unpaidVacations: 483.87 })],
  });

  assert.equal(
    report.retiredApprovalsCounted.count,
    1,
    "the report must declare how many retired approvals it counted — a module total that cannot " +
      "be found on the Deductions screen is unreadable without it",
  );
  assert.equal(
    report.retiredApprovalsCounted.amount,
    483.87,
    "the report must declare the money behind the retired approvals it counted",
  );
  assert.equal(
    report.differences.length,
    0,
    "the run charges exactly the retired approval, so the reconciliation must report NO difference" +
      " — this is the 934.74 EGP of false over-charge the August 2026 run reported",
  );

  // ---- 5. RETIRED MONEY IS NOT SCORED IN EITHER DIRECTION ------------------
  // The trap that the first cut of this fix walked straight into. Folding retired approvals into
  // the module total removed two false over-charges and created FIVE false under-charges worth
  // 3,597.53 EGP: an approval the source withdrew after the freeze, which the run also never
  // charged, is the module and the run AGREEING, not a shortfall.
  const unchargedRetired = reconcileDeductions({
    members: [member],
    sources: new Map([["b-172", source], [compact("B-172"), source]]),
    deductions: buildDeductionBuckets([retiredApproval], {
      countSupersededApprovedAfter: FROZEN_AT,
    }),
    // The run charged nothing for it — exactly Samia Ali Kasem Ali Gabr's August shape.
    draftRows: [draftRow({ unpaidVacations: null })],
  });
  assert.equal(
    unchargedRetired.differences.length,
    0,
    "a RETIRED approval the run never charged must NOT be reported as an under-charge — the money " +
      "was withdrawn, so the run and the module agree; this was 3,597.53 EGP of false shortfall",
  );
  assert.equal(
    unchargedRetired.explainedByRetiredApproval.length,
    1,
    "it must still be REPORTED under its own verdict — unscored is not the same as dropped",
  );
  assert.equal(
    unchargedRetired.explainedByRetiredApproval[0]?.verdict,
    "explained by a retired approval",
    "the row must carry the verdict that says why it is not scored",
  );

  // ---- 6. A REAL SHORTFALL IS STILL A SHORTFALL ----------------------------
  // The whole tool exists for this row. Money that is STILL approved and is not charged must keep
  // reporting, or the fix above becomes a way to lose the finding it was built to surface.
  const liveShortfall = reconcileDeductions({
    members: [member],
    sources: new Map([["b-172", source], [compact("B-172"), source]]),
    deductions: buildDeductionBuckets([candidate({ id: "live", status: "Approved for Payroll" })], {
      countSupersededApprovedAfter: FROZEN_AT,
    }),
    draftRows: [draftRow({ unpaidVacations: null })],
  });
  assert.equal(
    liveShortfall.differences.length,
    1,
    "a LIVE approval the run does not charge is a real under-charge and must still be reported — " +
      "the retired-approval carve-out must never swallow it",
  );
  assert.equal(
    liveShortfall.differences[0]?.verdict,
    "charged less",
    "a live approved figure the run charges 0.00 for is 'charged less', not 'explained'",
  );
}

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  rollupByEmployee,
  rollupBySource,
  rollupKpis,
  sanitizeDeductionInboxFilters,
  type DeductionInboxRow,
} from "../src/lib/deductions-governance/service.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceFilePath = path.resolve(
  here,
  "../src/lib/deductions-governance/service.ts",
);

function makeRow(overrides: Partial<DeductionInboxRow>): DeductionInboxRow {
  const base: DeductionInboxRow = {
    id: overrides.id ?? "row-1",
    sourceModule: "FIELD_WORKFORCE",
    sourceRecordId: "rec-1",
    candidateKey: "key-1",
    employeeCode: "A16",
    employeeHrIdCompact: "a16",
    employeeName: "Test Rep",
    monthKey: "2026-05",
    month: 5,
    year: 2026,
    deductionType: "no_activity",
    deductionUnit: "days",
    deductionValue: 1,
    estimatedAmount: 100,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: null,
    evidence: {},
    holidayContext: null,
    dates: ["2026-05-12"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-05-15T10:00:00.000Z",
    supersededAt: null,
    supersededByCandidateId: null,
    decision: null,
  };
  return { ...base, ...overrides };
}

export async function runDeductionsGovernanceServiceTests(): Promise<void> {
  // 1. sanitizeDeductionInboxFilters: passes through valid month, rejects invalid.
  {
    const sanitized = sanitizeDeductionInboxFilters({
      monthKey: "2026/5",
      sourceModule: "FIELD_WORKFORCE",
      deductionType: "no_activity",
      decisionStatus: "Pending",
      severity: "High",
      employeeSearch: "  Mohamed  ",
    });
    assert.equal(sanitized.monthKey, "2026-05", "monthKey must be normalized");
    assert.equal(sanitized.sourceModule, "FIELD_WORKFORCE");
    assert.equal(sanitized.deductionType, "no_activity");
    assert.equal(sanitized.decisionStatus, "Pending");
    assert.equal(sanitized.severity, "High");
    assert.equal(sanitized.employeeSearch, "Mohamed");
  }
  {
    const bad = sanitizeDeductionInboxFilters({
      monthKey: "not-a-month",
      sourceModule: "BOGUS" as unknown as "FIELD_WORKFORCE",
      deductionType: "no-such-type" as unknown as "no_activity",
      decisionStatus: "Unknown" as unknown as "Pending",
      severity: "Critical" as unknown as "High",
      employeeSearch: "",
    });
    assert.equal(bad.monthKey, undefined, "invalid monthKey must be dropped");
    assert.equal(bad.sourceModule, undefined, "invalid sourceModule must be dropped");
    assert.equal(bad.deductionType, undefined, "invalid deductionType must be dropped");
    assert.equal(bad.decisionStatus, undefined, "invalid decisionStatus must be dropped");
    assert.equal(bad.severity, undefined, "invalid severity must be dropped");
    assert.equal(bad.employeeSearch, undefined, "blank employeeSearch must be dropped");
  }

  // 2. rollupKpis: counts statuses correctly and sums estimated_amount only for approved buckets.
  {
    const rows: DeductionInboxRow[] = [
      makeRow({ id: "1", employeeCode: "A16", sourceModule: "FIELD_WORKFORCE", estimatedAmount: 100, decision: null }),
      makeRow({
        id: "2",
        employeeCode: "A16",
        sourceModule: "FIELD_WORKFORCE",
        estimatedAmount: 250,
        decision: {
          id: "d-2",
          candidateId: "2",
          decisionStatus: "Approved for Payroll",
          decisionReason: "Policy violation",
          hrNote: "",
          appliedDeductionValue: null,
          appliedAmount: null,
          payrollColumn: null,
          decidedBy: "hr1",
          decidedAt: null,
          resolvedAt: null,
          resolvedBy: null,
          payrollHandoffStatus: "Not pushed",
          lastExportId: null,
          finalizedSummaryId: null,
          actorRoleAtDecision: null,
          actorScopeAtDecision: null,
          createdAt: "",
          updatedAt: "",
        },
      }),
      makeRow({
        id: "3",
        employeeCode: "A17",
        sourceModule: "ATTENDANCE_DEVICE",
        estimatedAmount: 50,
        decision: {
          id: "d-3",
          candidateId: "3",
          decisionStatus: "Approved for Leave Adjustment",
          decisionReason: "Leave already covered",
          hrNote: "",
          appliedDeductionValue: null,
          appliedAmount: null,
          payrollColumn: null,
          decidedBy: "hr1",
          decidedAt: null,
          resolvedAt: null,
          resolvedBy: null,
          payrollHandoffStatus: "Not pushed",
          lastExportId: null,
          finalizedSummaryId: null,
          actorRoleAtDecision: null,
          actorScopeAtDecision: null,
          createdAt: "",
          updatedAt: "",
        },
      }),
      makeRow({
        id: "4",
        employeeCode: "A17",
        sourceModule: "VACATION",
        estimatedAmount: null,
        decision: {
          id: "d-4",
          candidateId: "4",
          decisionStatus: "Disputed",
          decisionReason: "Manager approved exception",
          hrNote: "",
          appliedDeductionValue: null,
          appliedAmount: null,
          payrollColumn: null,
          decidedBy: "hr1",
          decidedAt: null,
          resolvedAt: null,
          resolvedBy: null,
          payrollHandoffStatus: "Not pushed",
          lastExportId: null,
          finalizedSummaryId: null,
          actorRoleAtDecision: null,
          actorScopeAtDecision: null,
          createdAt: "",
          updatedAt: "",
        },
      }),
    ];
    const kpis = rollupKpis(rows);
    assert.equal(kpis.total, 4);
    assert.equal(kpis.pending, 1);
    assert.equal(kpis.approvedForPayroll, 1);
    assert.equal(kpis.approvedForLeaveAdjustment, 1);
    assert.equal(kpis.disputed, 1);
    assert.equal(kpis.employeesAffected, 2);
    assert.equal(kpis.activeSources, 3);
    assert.equal(kpis.estimatedAmountSubtotal, 300, "sum 250 + 50 only for approved-for-* buckets");
  }

  // 3. rollupBySource: counts roll up correctly per module + estimated subtotal only for calculated rows.
  {
    const rows: DeductionInboxRow[] = [
      makeRow({ id: "a", sourceModule: "FIELD_WORKFORCE", calculationStatus: "calculated", estimatedAmount: 100 }),
      makeRow({ id: "b", sourceModule: "FIELD_WORKFORCE", calculationStatus: "requires_payroll_review", estimatedAmount: 200 }),
      makeRow({ id: "c", sourceModule: "ATTENDANCE_DEVICE", calculationStatus: "calculated", estimatedAmount: 75 }),
    ];
    const groups = rollupBySource(rows);
    const fwc = groups.find((g) => g.sourceModule === "FIELD_WORKFORCE");
    const att = groups.find((g) => g.sourceModule === "ATTENDANCE_DEVICE");
    assert.ok(fwc, "expected FIELD_WORKFORCE bucket");
    assert.ok(att, "expected ATTENDANCE_DEVICE bucket");
    assert.equal(fwc!.count, 2);
    assert.equal(fwc!.pending, 2, "no decisions -> all pending");
    assert.equal(fwc!.estimatedAmountCalculatedSubtotal, 100, "only calculated row counts");
    assert.equal(att!.count, 1);
    assert.equal(att!.estimatedAmountCalculatedSubtotal, 75);
  }

  // 4. rollupByEmployee: dedups + sorts monthsAffected, respects limit.
  {
    const rows: DeductionInboxRow[] = [
      makeRow({ id: "1", employeeCode: "A16", employeeName: "A Sixteen", monthKey: "2026-05" }),
      makeRow({ id: "2", employeeCode: "A16", employeeName: "A Sixteen", monthKey: "2026-04" }),
      makeRow({ id: "3", employeeCode: "A16", employeeName: "A Sixteen", monthKey: "2026-05" }),
      makeRow({ id: "4", employeeCode: "A17", employeeName: "A Seventeen", monthKey: "2026-03" }),
    ];
    const groups = rollupByEmployee(rows);
    const a16 = groups.find((g) => g.employeeCode === "A16");
    assert.ok(a16);
    assert.deepEqual(a16!.monthsAffected, ["2026-04", "2026-05"], "months sorted and deduped");
    assert.equal(a16!.totalCandidates, 3);

    const limited = rollupByEmployee(rows, 1);
    assert.equal(limited.length, 1, "limit must cap output");
  }

  // 5. Safety scan: service.ts must not reference forbidden tables/RPCs.
  {
    const source = readFileSync(serviceFilePath, "utf8");
    const forbidden = [
      "salary_records",
      "salary_batches",
      "payroll_batches",
      "employee_leave_balances",
      "leave_transactions",
      "v2_vacation_requests",
    ];
    for (const table of forbidden) {
      // Allow the table name to appear inside comments (we have a documented
      // boundary section). Strip comments first, then assert the runtime path
      // does not touch the table.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      assert.equal(
        stripped.includes(table),
        false,
        `service.ts code path must not reference forbidden table "${table}"`,
      );
    }
  }

  // 6. Service surface: no exported function name signals payroll/leave mutation.
  {
    const surface = await import("../src/lib/deductions-governance/service.ts");
    const dangerous = /^(push|execute|mutate|writeLeave|updateSalary|deductPayroll)/i;
    for (const name of Object.keys(surface)) {
      if (typeof (surface as Record<string, unknown>)[name] !== "function") continue;
      assert.equal(
        dangerous.test(name),
        false,
        `service module must not export forbidden mutation "${name}"`,
      );
    }
  }
}

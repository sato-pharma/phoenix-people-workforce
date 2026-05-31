import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  APPROVED_FWC_DECISION_STATUSES,
  buildApprovedDecisionFilter,
  listFieldWorkforceApprovedDecisions,
  syncFieldWorkforceApprovedDecisions,
  toDeductionCandidateDraft,
  type FieldWorkforceApprovedDecisionRow,
} from "../src/lib/deductions-governance/connectors/field-workforce-compliance.ts";
import * as Connector from "../src/lib/deductions-governance/connectors/field-workforce-compliance.ts";
import { prepareCandidateInsertPayload } from "../src/lib/deductions-governance/service.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const connectorFilePath = path.resolve(
  here,
  "../src/lib/deductions-governance/connectors/field-workforce-compliance.ts",
);

function payrollRow(overrides: Partial<FieldWorkforceApprovedDecisionRow> = {}): FieldWorkforceApprovedDecisionRow {
  return {
    id: "fwc-decision-1",
    import_id: "fwc-import-42",
    recommendation_key: "rec-001",
    recommendation_type: "payroll_deduction",
    source_type: "no_activity",
    employee_code: "A100",
    employee_name: "Test Employee",
    month_key: "2026-05",
    dates: ["2026-05-12", "2026-05-13"],
    days_count: 2,
    severity: "Medium",
    decision_status: "Approved for Payroll Deduction Report",
    decision_reason: "Policy violation",
    hr_note: "Confirmed no activity",
    decided_at: "2026-05-25T10:00:00Z",
    decided_by: "HR1",
    estimated_amount: 1500,
    existing_coverage_status: "not_applicable",
    holiday_context: null,
    ...overrides,
  };
}

function leaveRow(overrides: Partial<FieldWorkforceApprovedDecisionRow> = {}): FieldWorkforceApprovedDecisionRow {
  return payrollRow({
    id: "fwc-decision-2",
    recommendation_key: "rec-002",
    recommendation_type: "leave_reconciliation",
    decision_status: "Approved for Leave Adjustment Report",
    decision_reason: "Leave already covered",
    ...overrides,
  });
}

type FakeProbeResult = { data: Array<{ id: string }> | null; error: { message: string; code?: string } | null };
type FakeInsertResult = { data: { id: string } | null; error: { message: string; code?: string } | null };

type FakeBuilderConfig = {
  selectRows?: Array<Record<string, unknown>>;
  selectError?: { message: string } | null;
  probeResults?: FakeProbeResult[];
  insertResults?: FakeInsertResult[];
  recordedFilters?: {
    decisionStatuses: string[][];
    importIds: string[];
    monthKeys: string[];
  };
};

function createFakeSupabase(config: FakeBuilderConfig) {
  const probes = [...(config.probeResults ?? [])];
  const inserts = [...(config.insertResults ?? [])];

  return {
    from(table: string) {
      if (table === "field_workforce_compliance_decisions") {
        const builder: Record<string, unknown> = {
          select() {
            return builder;
          },
          in(_col: string, values: string[]) {
            config.recordedFilters?.decisionStatuses.push([...values]);
            return builder;
          },
          eq(col: string, value: string) {
            if (col === "import_id") config.recordedFilters?.importIds.push(value);
            if (col === "month_key") config.recordedFilters?.monthKeys.push(value);
            return builder;
          },
          then(onFulfilled: (result: { data: unknown; error: unknown }) => unknown) {
            return Promise.resolve({
              data: config.selectRows ?? [],
              error: config.selectError ?? null,
            }).then(onFulfilled);
          },
        };
        return builder;
      }
      if (table === "deduction_candidates") {
        const probeBuilder = {
          select() {
            return probeBuilder;
          },
          eq() {
            return probeBuilder;
          },
          is() {
            return probeBuilder;
          },
          limit() {
            const next = probes.shift() ?? { data: [], error: null };
            return Promise.resolve(next);
          },
        };
        const insertBuilder = {
          select() {
            return insertBuilder;
          },
          single() {
            const next = inserts.shift() ?? { data: { id: "new-id" }, error: null };
            return Promise.resolve(next);
          },
        };
        return {
          select() {
            return probeBuilder.select();
          },
          insert() {
            return insertBuilder;
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown;
}

export async function runDeductionsGovernanceFwcConnectorTests(): Promise<void> {
  // 1. Approved-for-Payroll mapping.
  {
    const draft = toDeductionCandidateDraft(payrollRow());
    assert.equal(draft.sourceModule, "FIELD_WORKFORCE");
    assert.equal(draft.deductionType, "no_activity");
    assert.equal(draft.deductionUnit, "days");
    assert.equal(draft.deductionValue, 2);
    assert.equal(draft.calculationStatus, "requires_payroll_review");
    assert.equal(draft.estimatedAmount, null);
    assert.deepEqual(draft.dates, ["2026-05-12", "2026-05-13"]);
    assert.equal(draft.month, 5);
    assert.equal(draft.year, 2026);
    assert.equal(draft.reason, "Approved Field Workforce Compliance no-activity recommendation");
    const evidence = draft.evidence as Record<string, unknown>;
    assert.equal(evidence.importId, "fwc-import-42");
    assert.equal(evidence.recommendationKey, "rec-001");
    assert.equal(evidence.decisionReason, "Policy violation");
    assert.equal(evidence.hrNote, "Confirmed no activity");
    assert.equal(draft.sourceRecordId, "fwc-import-42:rec-001");
  }

  // 2. Approved-for-Leave-Adjustment mapping.
  {
    const draft = toDeductionCandidateDraft(leaveRow());
    assert.equal(draft.deductionType, "retroactive_leave");
    assert.equal(draft.calculationStatus, "not_applicable");
    assert.equal(draft.estimatedAmount, null);
    assert.equal(draft.deductionUnit, "days");
    assert.equal(draft.reason, "Approved Field Workforce Compliance leave adjustment recommendation");
  }

  // 3. Severity normalization: invalid values become null.
  {
    const draft = toDeductionCandidateDraft(payrollRow({ severity: "Critical" as unknown as string }));
    assert.equal(draft.severity, null);
    const draftValid = toDeductionCandidateDraft(payrollRow({ severity: "High" }));
    assert.equal(draftValid.severity, "High");
  }

  // 4. Approved-decision filter shape — only the two approved statuses.
  {
    const filter = buildApprovedDecisionFilter();
    assert.deepEqual([...filter.decisionStatuses], [
      "Approved for Payroll Deduction Report",
      "Approved for Leave Adjustment Report",
    ]);
    assert.equal(APPROVED_FWC_DECISION_STATUSES.length, 2);
    const set = new Set<string>(APPROVED_FWC_DECISION_STATUSES);
    assert.equal(set.has("Pending"), false);
    assert.equal(set.has("Disputed"), false);
    assert.equal(set.has("Needs Follow-up"), false);
    assert.equal(set.has("Do Not Take Action"), false);
    assert.equal(set.has("Cancelled"), false);
    assert.equal(set.has("Resolved"), false);
  }

  // 4b. listFieldWorkforceApprovedDecisions filters by the two approved statuses
  // (verified via stub that records .in() args).
  {
    const recordedFilters = { decisionStatuses: [] as string[][], importIds: [] as string[], monthKeys: [] as string[] };
    const fake = createFakeSupabase({ selectRows: [], recordedFilters });
    await listFieldWorkforceApprovedDecisions({
      monthKey: "2026-05",
      supabase: fake as never,
    });
    assert.equal(recordedFilters.decisionStatuses.length, 1);
    assert.deepEqual(recordedFilters.decisionStatuses[0], [
      "Approved for Payroll Deduction Report",
      "Approved for Leave Adjustment Report",
    ]);
    assert.deepEqual(recordedFilters.monthKeys, ["2026-05"]);
  }

  // 5. Deterministic candidate_key for the same row.
  {
    const row = payrollRow();
    const draftA = toDeductionCandidateDraft(row);
    const draftB = toDeductionCandidateDraft(row);
    const payloadA = prepareCandidateInsertPayload(draftA, { createdBy: "tester" });
    const payloadB = prepareCandidateInsertPayload(draftB, { createdBy: "tester" });
    assert.equal(payloadA.candidate_key, payloadB.candidate_key);
    assert.equal(payloadA.source_module, "FIELD_WORKFORCE");
  }

  // 6. estimatedAmount is always null in produced drafts (both branches).
  {
    const draftPayroll = toDeductionCandidateDraft(payrollRow({ estimated_amount: 9999 }));
    const draftLeave = toDeductionCandidateDraft(leaveRow({ estimated_amount: 4242 }));
    assert.equal(draftPayroll.estimatedAmount, null);
    assert.equal(draftLeave.estimatedAmount, null);
  }

  // 7. Safety: no exported function matches forbidden mutation names.
  {
    const forbidden = /salary|payrollPush|leaveBalance|leaveTransaction|execute|mutate/i;
    const exportNames = Object.keys(Connector);
    for (const name of exportNames) {
      assert.equal(
        forbidden.test(name),
        false,
        `Connector must not export a name matching forbidden mutation pattern: ${name}`,
      );
    }
    const source = readFileSync(connectorFilePath, "utf8");
    const forbiddenTables = [
      "salary_records",
      "salary_batches",
      "employee_leave_balances",
      "leave_transactions",
      "v2_vacation_requests",
    ];
    for (const table of forbiddenTables) {
      assert.equal(
        source.includes(table),
        false,
        `Connector source must not reference forbidden table ${table}`,
      );
    }
  }

  // 8. Duplicate sync skip: probe returns an existing row → created=0, skipped=1.
  {
    const row = payrollRow();
    const fake = createFakeSupabase({
      selectRows: [row as unknown as Record<string, unknown>],
      probeResults: [{ data: [{ id: "existing-candidate" }], error: null }],
    });
    const result = await syncFieldWorkforceApprovedDecisions({
      monthKey: "2026-05",
      createdBy: "tester",
      supabase: fake as never,
    });
    assert.equal(result.sourceTotal, 1);
    assert.equal(result.created, 0);
    assert.equal(result.skippedExisting, 1);
    assert.equal(result.warnings.length, 0);
  }

  // 9. Insert path invokes audit logger with entityType 'deduction_candidate'.
  {
    const row = payrollRow();
    const fake = createFakeSupabase({
      selectRows: [row as unknown as Record<string, unknown>],
      probeResults: [{ data: [], error: null }],
      insertResults: [{ data: { id: "candidate-xyz" }, error: null }],
    });
    const auditCalls: Array<{ entityType: string; entityId: string | null | undefined; summary: string }> = [];
    const result = await syncFieldWorkforceApprovedDecisions({
      monthKey: "2026-05",
      createdBy: "tester",
      supabase: fake as never,
      auditLogger: async (input) => {
        auditCalls.push({
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          summary: input.summary,
        });
      },
    });
    assert.equal(result.created, 1);
    assert.equal(result.skippedExisting, 0);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].entityType, "deduction_candidate");
    assert.equal(auditCalls[0].entityId, "candidate-xyz");
    assert.match(auditCalls[0].summary, /Field Workforce Compliance/);
  }
}

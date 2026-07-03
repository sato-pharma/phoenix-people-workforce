// Bridges a real (non-zero) attendance settlement outcome into the payroll
// governance pipeline — the ONLY point where this module touches
// deductions-governance. Never called for missing-punch or dispute_upheld
// outcomes (both carry deduction_days === 0 by construction upstream).
//
// Reuses the existing audited candidate-creation path (insertDeductionCandidateDrafts)
// and adds exactly one new, narrowly-scoped decision path
// (recordSystemApprovedAttendanceDecision) for the CEO/COO-approved policy
// that a confirmed/auto-confirmed/dispute-rejected attendance settlement goes
// straight to "Approved for Payroll" with no further human review — see that
// function's own doc comment in deductions-governance/service.ts for the full
// reasoning on why bypassing the human-actor gate is safe here.
//
// candidate_key uses sourceRecordId = "digest-line-{id}" — a distinct,
// collision-free namespace from the older ATTENDANCE_DEVICE governance
// connector's `fingerprint:{date}:{hrId}:{status}` keys (src/lib/deductions-
// governance/connectors/attendance-device.ts), so the two never fight over
// the same row. (The direct/legacy generator that duplicated the connector's
// own keys — the actual audit-flagged double-deduction risk — was removed
// entirely; this settlement flow is now the only writer of ATTENDANCE_DEVICE
// candidates besides that connector.)

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { buildDeductionCandidateKey } from "@/lib/deductions-governance/candidate-key";
import { insertDeductionCandidateDrafts, recordSystemApprovedAttendanceDecision } from "@/lib/deductions-governance/service.ts";
import type { DeductionCandidateDraft, DeductionType } from "@/lib/deductions-governance/types.ts";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";

const SYSTEM_ACTOR = "system:attendance-settlement";

function deductionTypeForLineStatus(status: "late" | "short_hours"): DeductionType {
  return status === "late" ? "late_arrival" : "short_hours";
}

function monthKeyFor(workDate: string): { monthKey: string; month: number; year: number } {
  const [year, month] = workDate.split("-").map(Number);
  return { month, monthKey: `${year}-${String(month).padStart(2, "0")}`, year };
}

async function findCandidateIdByKey(candidateKey: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deduction_candidates")
    .select("id")
    .eq("source_module", "ATTENDANCE_DEVICE")
    .eq("candidate_key", candidateKey)
    .is("superseded_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

export async function pushAttendanceSettlementToPayroll(input: {
  digestLineId: number;
  employeeHrId: string;
  employeeName?: string | null;
  workDate: string;
  lineStatus: "late" | "short_hours";
  deductionDays: number;
  outcome: "confirmed" | "auto_confirmed" | "dispute_rejected";
}): Promise<{ skippedDryRun: boolean; candidateId: string | null }> {
  if (input.deductionDays <= 0) return { candidateId: null, skippedDryRun: false };

  const settings = await getDigestSettings();
  if (settings.dryRun) {
    // "Dry-run first cycle": settlement + notifications still run for real, but
    // no payroll candidate is created — proves accuracy before it can bite.
    return { candidateId: null, skippedDryRun: true };
  }

  const deductionType = deductionTypeForLineStatus(input.lineStatus);
  const { monthKey, month, year } = monthKeyFor(input.workDate);
  const sourceRecordId = `digest-line-${input.digestLineId}`;

  const draft: DeductionCandidateDraft = {
    calculationStatus: "calculated",
    createdBy: SYSTEM_ACTOR,
    dates: [input.workDate],
    deductionType,
    deductionUnit: "days",
    deductionValue: input.deductionDays,
    employeeCode: input.employeeHrId,
    employeeName: input.employeeName ?? null,
    evidence: { digestLineId: input.digestLineId, outcome: input.outcome },
    month,
    monthKey,
    reason: `Weekly-digest attendance settlement (${input.outcome})`,
    severity: input.deductionDays >= 1 ? "High" : "Medium",
    sourceModule: "ATTENDANCE_DEVICE",
    sourceRecordId,
    year,
  };

  await insertDeductionCandidateDrafts({
    createdBy: SYSTEM_ACTOR,
    drafts: [draft],
    sourceLabel: "attendance-weekly-digest-settlement",
  });

  const candidateKey = buildDeductionCandidateKey({
    dates: draft.dates,
    deductionType,
    employeeCode: input.employeeHrId,
    monthKey,
    sourceModule: "ATTENDANCE_DEVICE",
    sourceRecordId,
  });
  const candidateId = await findCandidateIdByKey(candidateKey);
  if (!candidateId) {
    throw new Error(`Attendance settlement candidate was not found after insert (key ${candidateKey}).`);
  }

  const decisionReason =
    input.outcome === "auto_confirmed"
      ? "Employee did not respond (auto-confirmed)"
      : input.outcome === "dispute_rejected"
        ? "Dispute reviewed and rejected"
        : "Employee confirmed";

  await recordSystemApprovedAttendanceDecision({
    candidateId,
    decisionReason,
    hrNote: input.outcome === "dispute_rejected" ? `Dispute reviewed and rejected for ${input.workDate}.` : undefined,
  });

  return { candidateId, skippedDryRun: false };
}

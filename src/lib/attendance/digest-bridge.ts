// Applies a settled weekly-digest answer to the deduction candidate the month-end
// Fingerprint connector created for that same day.
//
// WHY A BRIDGE RATHER THAN A SECOND WRITER. The 2026-07 digest created its own
// deduction candidates at settlement time, which meant two independent things could
// write the same employee-day. That shape is what charged 19 employee-days twice in
// July 2026 (8,822.54 EGP) when the vacation collectors were insert-only. Here the
// connector stays the sole author of deductions_candidates and this module only
// answers the question the candidate is already asking, keyed on the connector's own
// `${hrId}:${dateIso}` source_record_id.
//
// WHAT IT REFUSES TO DO
//   • It never touches a candidate whose decision is not still Pending. A human who
//     has already ruled on a day outranks a digest answer, including an auto-confirm.
//   • It never applies a settlement recorded under dry-run. Owner decision 2026-09-08
//     made silence auto-confirming, which moves money with nobody deciding; the
//     dry-run cycle exists so the numbers prove themselves before that can happen.
//   • It stamps `applied_candidate_id` write-once, enforced by a trigger, so a re-run
//     cannot answer the same day twice.

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recordDecision } from "@/lib/deductions/service.ts";
import type { DeductionsDecisionStatus } from "@/lib/deductions/types.ts";

const SYSTEM_ACTOR = "system:weekly-attendance-digest";

export type BridgeResult = {
  monthKey: string;
  considered: number;
  applied: number;
  skippedAlreadyDecided: number;
  skippedNoCandidate: number;
  skippedDryRun: number;
  warnings: string[];
};

type SettlementRow = {
  id: number;
  employee_hr_id: string;
  work_date: string;
  action: string;
  digest_line_id: number;
};

/**
 * Only three outcomes exist, and every one of them is a person's decision.
 *
 * There is no auto-confirm: the module notifies nobody (owner, 2026-09-08), so an
 * unanswered day has no settlement at all and never reaches this function. Its
 * candidate simply stays Pending in the month-end queue, which is the same place it
 * would have been if this module did not exist.
 */
function decisionFor(action: string): { status: DeductionsDecisionStatus; reason: string } | null {
  switch (action) {
    case "confirmed":
      return { status: "Approved for Payroll", reason: "Employee confirmed this day in their weekly attendance digest." };
    case "dispute_rejected":
      return { status: "Approved for Payroll", reason: "Dispute reviewed and rejected." };
    case "dispute_upheld":
      return { status: "Do Not Take Action", reason: "Dispute upheld — the day was covered." };
    default:
      return null;
  }
}

/**
 * Apply every unapplied settlement whose work_date falls in `monthKey` to the
 * matching fingerprint candidate. Safe to re-run: applied settlements are skipped by
 * the `applied_candidate_id is null` filter, and a candidate that a person has
 * already decided is left exactly as they left it.
 */
export async function applyDigestAnswersForMonth(monthKey: string): Promise<BridgeResult> {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error(`Validation: monthKey must be YYYY-MM, received "${monthKey}".`);
  }
  const supabase = getSupabaseAdmin();
  const monthStart = `${monthKey}-01`;
  const [year, month] = monthKey.split("-").map(Number);
  const monthEnd = `${monthKey}-${String(new Date(year!, month!, 0).getDate()).padStart(2, "0")}`;

  const { data, error } = await supabase
    .from("attendance_settlements")
    .select("id,employee_hr_id,work_date,action,digest_line_id")
    .is("applied_candidate_id", null)
    .gte("work_date", monthStart)
    .lte("work_date", monthEnd)
    .order("work_date", { ascending: true })
    .limit(1000);
  if (error) throw error;

  const settlements = (data ?? []) as SettlementRow[];
  const result: BridgeResult = {
    monthKey,
    considered: settlements.length,
    applied: 0,
    skippedAlreadyDecided: 0,
    skippedNoCandidate: 0,
    skippedDryRun: 0,
    warnings: [],
  };
  if (!settlements.length) return result;

  // Which of these came from a dry-run digest? Read the flag frozen on the DIGEST at
  // generation time, never the live setting — a cycle that ran in dry-run must stay
  // dry-run even after the flag is switched off.
  const { data: dryData, error: dryError } = await supabase
    .from("attendance_digest_lines")
    .select("id,attendance_weekly_digests!inner(dry_run)")
    .in("id", settlements.map((row) => row.digest_line_id));
  if (dryError) throw dryError;
  const dryByLine = new Map<number, boolean>();
  for (const raw of (dryData ?? []) as Array<Record<string, unknown>>) {
    const nested = raw.attendance_weekly_digests as { dry_run?: boolean } | Array<{ dry_run?: boolean }> | null;
    const flag = Array.isArray(nested) ? nested[0]?.dry_run : nested?.dry_run;
    dryByLine.set(Number(raw.id), flag !== false);
  }

  for (const settlement of settlements) {
    if (dryByLine.get(settlement.digest_line_id) !== false) {
      result.skippedDryRun += 1;
      continue;
    }
    const decision = decisionFor(settlement.action);
    if (!decision) {
      result.warnings.push(`Settlement ${settlement.id} has an unmapped action "${settlement.action}".`);
      continue;
    }

    const sourceRecordId = `${settlement.employee_hr_id}:${settlement.work_date}`;
    const { data: candidateData, error: candidateError } = await supabase
      .from("deductions_candidates")
      .select("id")
      .eq("category", "fingerprint")
      .eq("month_key", monthKey)
      .eq("source_record_id", sourceRecordId)
      .is("superseded_at", null)
      .maybeSingle();
    if (candidateError) throw candidateError;
    const candidateId = (candidateData as { id: string } | null)?.id ?? null;
    if (!candidateId) {
      // Normal, not an error: a day the employee confirmed can still be cancelled by
      // evidence that arrived afterwards, and then no candidate is ever created.
      result.skippedNoCandidate += 1;
      continue;
    }

    const { data: existingDecision, error: decisionError } = await supabase
      .from("deductions_decisions")
      .select("decision_status")
      .eq("candidate_id", candidateId)
      .maybeSingle();
    if (decisionError) throw decisionError;
    const currentStatus = (existingDecision as { decision_status: string } | null)?.decision_status ?? "Pending";
    if (currentStatus !== "Pending") {
      result.skippedAlreadyDecided += 1;
      continue;
    }

    await recordDecision({
      actor: { role: "Super Admin", hrId: SYSTEM_ACTOR, loginId: SYSTEM_ACTOR },
      candidateId,
      decisionStatus: decision.status,
      decisionReason: decision.reason,
      hrNote: `Applied from the weekly attendance digest settlement recorded on ${settlement.work_date}.`,
    });

    const { error: stampError } = await supabase
      .from("attendance_settlements")
      .update({ applied_candidate_id: candidateId, applied_at: new Date().toISOString() })
      .eq("id", settlement.id)
      .is("applied_candidate_id", null);
    if (stampError) throw stampError;
    result.applied += 1;
  }

  await writeAuditLog({
    actorLoginId: SYSTEM_ACTOR,
    entityId: monthKey,
    entityType: "attendance_digest_bridge_run",
    newValues: result as unknown as Record<string, unknown>,
    summary: `Weekly-digest answers applied to ${result.applied} fingerprint candidate(s) for ${monthKey}`,
  });

  return result;
}

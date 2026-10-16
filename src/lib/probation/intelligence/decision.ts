// Probation final decision (Phase 10). The decision is an AUTHORIZED HUMAN action — the engine
// never decides. Pass / Terminate only (Extend was removed by owner policy). Side effects run
// EXACTLY ONCE (guarded by side_effects_applied_at). A consolidated-report snapshot is captured at
// decision time as the defensible record.

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { getEmployeeDirectoryRows, invalidateEmployeeDirectoryCache } from "@/lib/employees/employee-directory";
import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { isProbationAdministrator } from "@/lib/probation/service";
import { resignEmployeeAndOpenVacancy } from "@/lib/resignations/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { buildConsolidatedReport } from "./consolidated-report";
import { getCaseScore } from "./scoring-service";
import type { ProbationCaseDecision } from "./types";

// Owner-confirmed decision authority: CEO + Super Admin/HR (company-wide) + NSM (own line/chain).
export function canDecideProbation(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "CEO" || access.role === "National Sales Manager" || isProbationAdministrator(access);
}

function norm(v: string | null | undefined): string {
  return normalizeHrId(v) ?? String(v ?? "").trim().toLowerCase();
}

/**
 * Scope guard: CEO / Super Admin decide company-wide; an NSM may only decide for an employee in
 * their own management chain (they cannot decide another line's rep).
 */
async function assertDecisionScope(access: AccessContext, employeeHrId: string): Promise<void> {
  if (access.role === "CEO" || isProbationAdministrator(access)) return; // company-wide
  // NSM: must be in the employee's management chain.
  const rows = await getEmployeeDirectoryRows();
  const byHrId = new Map(rows.map((r) => [norm(r.hrId), r] as const));
  const caller = norm(access.hrId);
  let cur = byHrId.get(norm(employeeHrId)) ?? null;
  const seen = new Set<string>();
  // Walk up managers from the employee; if we hit the caller, they're in the chain.
  let mgrId = norm(cur?.managerHrId);
  while (mgrId && !seen.has(mgrId)) {
    if (mgrId === caller) return;
    seen.add(mgrId);
    cur = byHrId.get(mgrId) ?? null;
    mgrId = norm(cur?.managerHrId);
  }
  throw new Error("Forbidden: this probation case is outside your scope.");
}

export type DecisionInput = {
  outcome: ProbationCaseDecision; // "pass" | "terminate"
  comment: string;
  evidenceAcknowledged: boolean;
  /** Required when the case is not decision-ready (human override of the readiness signal). */
  overrideReason?: string | null;
};

type CaseRow = {
  id: string; employee_hr_id: string; status: string; decision: string | null;
  decision_reason: string | null; decision_by: string | null;
  side_effects_applied_at: string | null;
};

export async function decideProbation(
  access: AccessContext,
  caseId: string,
  input: DecisionInput,
): Promise<{ caseId: string; decision: ProbationCaseDecision; sideEffectsApplied: boolean }> {
  if (input.outcome !== "pass" && input.outcome !== "terminate") {
    throw new Error("Validation failed: outcome must be pass or terminate.");
  }
  if (!input.comment || !input.comment.trim()) {
    throw new Error("Validation failed: a decision comment is required.");
  }
  if (!input.evidenceAcknowledged) {
    throw new Error("Validation failed: you must acknowledge you have reviewed the consolidated evidence.");
  }
  if (!canDecideProbation(access)) {
    throw new Error("Forbidden: you are not authorized to record a probation decision.");
  }

  const supabase = getSupabaseAdmin();
  const { data: caseData, error: cErr } = await supabase
    .from("probation_cases")
    .select("id, employee_hr_id, status, decision, decision_reason, decision_by, side_effects_applied_at")
    .eq("id", caseId)
    .maybeSingle();
  if (cErr) throw cErr;
  const probationCase = caseData as CaseRow | null;
  if (!probationCase) throw new Error("Not found: probation case does not exist.");

  await assertDecisionScope(access, probationCase.employee_hr_id);

  // Idempotency / no double-decide — with recovery. A case can be 'decided' but have its side effects
  // not yet applied if a prior attempt's mutation failed and released the slot. In that case we RE-DRIVE
  // the side effects for the PERSISTED decision (never a new/different outcome) instead of conflicting.
  if (probationCase.decision || probationCase.status === "decided") {
    if (probationCase.side_effects_applied_at) {
      throw new Error("Conflict: this probation case has already been decided.");
    }
    const persisted = probationCase.decision as ProbationCaseDecision;
    const applied = await applyDecisionSideEffects(
      caseId,
      probationCase.employee_hr_id,
      persisted,
      probationCase.decision_reason ?? "Probation decision.",
      probationCase.decision_by ?? (norm(access.hrId) || access.loginId || access.role),
    );
    return { caseId, decision: persisted, sideEffectsApplied: applied };
  }

  // Require an override reason when the case is not decision-ready (human owns the override).
  const scored = await getCaseScore(caseId);
  if (!scored.score.decisionReady && !(input.overrideReason && input.overrideReason.trim())) {
    throw new Error("Validation failed: the case is not decision-ready; an override reason is required to proceed.");
  }

  // Capture the defensible snapshot at decision time.
  const snapshot = await buildConsolidatedReport(access, caseId).catch(() => null);

  const now = new Date().toISOString();
  const actorHrId = norm(access.hrId) || access.loginId || access.role;

  const { data: decidedRow, error: updErr } = await supabase
    .from("probation_cases")
    .update({
      decision: input.outcome,
      decision_reason: input.comment.trim(),
      decision_by: actorHrId,
      decision_at: now,
      status: "decided",
      evidence_acknowledged: true,
      decision_snapshot: snapshot ? (snapshot as unknown as Record<string, unknown>) : null,
      updated_at: now,
    })
    .eq("id", caseId)
    .is("decision", null) // guard: only the first writer sets the decision
    .select("id")
    .maybeSingle();
  if (updErr) throw updErr;
  // If no row changed, another concurrent decider already set the decision. We must NOT proceed to side
  // effects with THIS caller's outcome (which may differ from the persisted one) — abort.
  if (!decidedRow) {
    throw new Error("Conflict: this probation case was decided by another action.");
  }

  const sideEffectsApplied = await applyDecisionSideEffects(
    caseId,
    probationCase.employee_hr_id,
    input.outcome,
    input.comment.trim(),
    actorHrId,
  );

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actorHrId,
    entityType: "probation_decision",
    entityId: caseId,
    newValues: {
      outcome: input.outcome,
      employeeHrId: probationCase.employee_hr_id,
      decisionReady: scored.score.decisionReady,
      overrideReason: input.overrideReason ?? null,
      sideEffectsApplied,
    },
    summary: `Probation decision ${input.outcome} for ${probationCase.employee_hr_id} by ${actorHrId}`,
  });

  return { caseId, decision: input.outcome, sideEffectsApplied };
}

/**
 * Apply the decision side effects EXACTLY ONCE. Guarded by side_effects_applied_at: the update
 * only proceeds when it is still null, so a retry (or concurrent call) can never double-apply.
 */
async function applyDecisionSideEffects(
  caseId: string,
  employeeHrId: string,
  outcome: ProbationCaseDecision,
  reason: string,
  actorHrId: string,
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Claim the side-effect slot atomically (null -> now); if no row updates, someone already did it.
  const { data: claimed, error: claimErr } = await supabase
    .from("probation_cases")
    .update({ side_effects_applied_at: now })
    .eq("id", caseId)
    .is("side_effects_applied_at", null)
    .select("id")
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claimed) return false; // already applied — no-op

  // The real mutation runs AFTER claiming the slot (so concurrent callers can't double-apply). If it
  // throws, we RELEASE the slot (back to null) so the decision is not stranded 'applied' — a later
  // decideProbation call re-drives it for the persisted decision. Then rethrow.
  try {
    if (outcome === "pass") {
      const { error } = await supabase
        .from("employees")
        .update({ employment_status: "active", organogram_visible: true, payroll_eligible: true, updated_at: now })
        .eq("hr_id", employeeHrId);
      if (error) throw error;
      // Payroll eligibility is read from the cached directory; without this a payroll draft built in the next
      // minute and a half would still leave this employee out.
      invalidateEmployeeDirectoryCache();
    } else {
      // Terminate → resignation + vacancy. Access intentionally omitted (probation scope is broader
      // than the generic canSeeEmployee — see the probation-scope memory).
      await resignEmployeeAndOpenVacancy(
        employeeHrId,
        {
          effectiveDate: now.slice(0, 10),
          employeeHrId,
          employeeStatus: "terminated",
          reason: reason || "Probation termination.",
          submittedDate: now.slice(0, 10),
          workflowNotes: `Probation termination from probation case ${caseId}.`,
        },
        actorHrId,
        undefined,
        // Suppress the voluntary-resignation notification: a probation termination is a company
        // decision, not a resignation, and its recipients/template must be owner-confirmed separately.
        { suppressWorkflowNotification: true },
      );
    }
  } catch (mutationError) {
    try {
      await supabase.from("probation_cases").update({ side_effects_applied_at: null }).eq("id", caseId);
    } catch {
      // best-effort release; the decision remains recoverable via the persisted null slot
    }
    throw mutationError;
  }
  return true;
}
